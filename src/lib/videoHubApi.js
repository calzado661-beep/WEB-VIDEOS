import { getVideoSource, parseDurationSeconds } from '../videoUtils'
import { withLearningAccess, validateLearningSequence } from '../learningRules'
import { isSupabaseConfigured, supabase } from './supabase'

const VIEWER_ROLES = ['operator', 'boss']
const DATABASE_PROVIDERS = new Set([
  'youtube',
  'google_drive',
  'vimeo',
  'loom',
  'direct',
  'supabase_storage',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ID_BATCH_SIZE = 100
const STORAGE_SIGNED_URL_TTL_SECONDS = 60 * 60
const STORAGE_SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000
const LOGIN_FUNCTION_URL = '/.netlify/functions/login-with-password'
const CREATE_USER_FUNCTION_URL = '/.netlify/functions/create-user'
const UPDATE_USER_FUNCTION_URL = '/.netlify/functions/update-user'
const SAVE_SNAPSHOT_FUNCTION_URL = '/.netlify/functions/save-admin-snapshot'
const IMPORT_DRIVE_VIDEOS_FUNCTION_URL = '/.netlify/functions/import-drive-videos'
const DOCUMENTS_BUCKET = 'document-assets'
const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024
const DOCUMENT_MIME_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
])

export class VideoHubApiError extends Error {
  constructor(message, { code = '', details = '', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'VideoHubApiError'
    this.code = code
    this.details = details
  }
}

function getClient() {
  if (!isSupabaseConfigured || !supabase) {
    throw new VideoHubApiError(
      'Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.',
      { code: 'SUPABASE_NOT_CONFIGURED' },
    )
  }
  return supabase
}

function throwDatabaseError(error, operation) {
  if (!error) return
  throw new VideoHubApiError(`${operation}: ${error.message}`, {
    code: error.code || 'SUPABASE_ERROR',
    details: error.details || error.hint || '',
    cause: error,
  })
}

function chunk(values, size = ID_BATCH_SIZE) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''))
}

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()

  const bytes = new Uint8Array(16)
  if (!globalThis.crypto?.getRandomValues) {
    throw new VideoHubApiError('Este navegador no puede generar identificadores seguros.', {
      code: 'CRYPTO_UNAVAILABLE',
    })
  }
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'seccion'
}

function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return 'Video'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

function mapSettings(row) {
  if (!row) return null
  return {
    productName: row.product_name,
    welcomeTitle: row.welcome_title,
    welcomeMessage: row.welcome_message,
    supportMessage: row.support_message,
    allowLightMode: row.allow_light_mode,
    requireQuizPhoto: Boolean(row.require_quiz_photo),
  }
}

function mapDocumentRow(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sectionId: row.section_id,
    audience: row.audience || 'both',
    title: row.title,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size) || 0,
    storageBucket: row.storage_bucket,
    storageObjectPath: row.storage_object_path,
    order: row.sort_order || 0,
    createdAt: row.created_at,
  }
}

function resolveDocumentMimeType(file) {
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || ''
  const expectedMimeType = DOCUMENT_MIME_TYPES.get(extension)
  if (!expectedMimeType) return ''
  if (!file.type || file.type === 'application/octet-stream') return expectedMimeType
  return file.type === expectedMimeType ? expectedMimeType : ''
}

async function requestFunction(url, { body, accessToken } = {}) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body || {}),
    })
  } catch (cause) {
    throw new VideoHubApiError('No se pudo conectar con el servicio de acceso.', {
      code: 'FUNCTION_UNREACHABLE',
      cause,
    })
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new VideoHubApiError(payload.error || 'El servicio no pudo completar la solicitud.', {
      code: payload.code || `FUNCTION_HTTP_${response.status}`,
      details: payload.retry_after ? String(payload.retry_after) : '',
    })
  }
  return payload
}

async function dispatchDriveVideoImports(videoIds, accessToken) {
  const ids = [...new Set((videoIds || []).filter(isUuid))].slice(0, 10)
  if (!ids.length || !accessToken) return

  const requests = await Promise.allSettled(ids.map((videoId) => requestFunction(IMPORT_DRIVE_VIDEOS_FUNCTION_URL, {
    accessToken,
    body: { videoIds: [videoId] },
  })))
  const failedRequest = requests.find((result) => result.status === 'rejected')
  if (failedRequest) throw failedRequest.reason
}

export async function queueDriveVideoImports(videoIds) {
  const session = await getCurrentSession()
  if (!session?.access_token) return
  await dispatchDriveVideoImports(videoIds, session.access_token)
}

async function selectRowsByIds(table, idColumn, ids, columns = '*') {
  if (!ids.length) return []
  const client = getClient()
  const results = await Promise.all(
    chunk(ids).map((batch) => client.from(table).select(columns).in(idColumn, batch)),
  )
  return results.flatMap((result) => {
    throwDatabaseError(result.error, `No se pudo leer ${table}`)
    return result.data || []
  })
}

async function resolveSourceUrl(source, previousVideo = null) {
  if (!source) return { url: '', expiresAt: null }
  if (source.provider !== 'supabase_storage') {
    return { url: source.source_url || '', expiresAt: null }
  }
  if (!source.storage_bucket || !source.storage_object_path) {
    return { url: '', expiresAt: null }
  }

  const previousSource = previousVideo?.source
  const previousExpiry = Date.parse(previousSource?.signedUrlExpiresAt || '')
  if (
    previousSource?.provider === 'supabase_storage'
    && previousSource.storageBucket === source.storage_bucket
    && previousSource.storageObjectPath === source.storage_object_path
    && previousVideo.url
    && previousExpiry > Date.now() + STORAGE_SIGNED_URL_REFRESH_MARGIN_MS
  ) {
    return { url: previousVideo.url, expiresAt: previousSource.signedUrlExpiresAt }
  }

  const { data, error } = await getClient()
    .storage
    .from(source.storage_bucket)
    .createSignedUrl(source.storage_object_path, STORAGE_SIGNED_URL_TTL_SECONDS)

  // Mantener visible la tarjeta aunque Storage no pueda crear la URL temporal.
  if (error || !data?.signedUrl) return { url: '', expiresAt: null }
  return {
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + STORAGE_SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  }
}

export async function getCurrentSession() {
  const { data, error } = await getClient().auth.getSession()
  throwDatabaseError(error, 'No se pudo recuperar la sesión')
  return data.session || null
}

export async function establishSession(tokens) {
  const accessToken = tokens?.access_token || tokens?.accessToken
  const refreshToken = tokens?.refresh_token || tokens?.refreshToken
  if (!accessToken || !refreshToken) {
    throw new VideoHubApiError('La respuesta de acceso no contiene una sesión válida.', {
      code: 'INVALID_SESSION_TOKENS',
    })
  }

  const { data, error } = await getClient().auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  throwDatabaseError(error, 'No se pudo establecer la sesión')
  return data.session || null
}

export async function loginWithCredentials(username, password) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  if (!normalizedUsername) {
    throw new VideoHubApiError('Ingresa tu usuario.', {
      code: 'EMPTY_USERNAME',
    })
  }
  if (!String(password || '')) {
    throw new VideoHubApiError('Ingresa tu contraseña.', {
      code: 'EMPTY_PASSWORD',
    })
  }

  const payload = await requestFunction(LOGIN_FUNCTION_URL, {
    body: { username: normalizedUsername, password },
  })
  const session = await establishSession(payload)
  const context = await getCurrentAccessContext()

  if (
    (payload.role && payload.role !== context.role)
    || (payload.organization_id && payload.organization_id !== context.organizationId)
    || (payload.user_id && payload.user_id !== context.userId)
  ) {
    await signOut()
    throw new VideoHubApiError('La sesión recibida no coincide con el perfil autorizado.', {
      code: 'SESSION_CONTEXT_MISMATCH',
    })
  }

  return { session, context }
}

async function withAdminSession(callback) {
  const session = await getCurrentSession()
  if (!session?.access_token) {
    throw new VideoHubApiError('La sesión administrativa ya no es válida.', {
      code: 'SESSION_REQUIRED',
    })
  }
  return callback(session.access_token)
}

export async function listManagedUsers() {
  const context = await getCurrentAccessContext()
  const { data, error } = await getClient()
    .from('profiles')
    .select('user_id,username,display_name,role,active,created_at,job_title,department,require_quiz_photo_override')
    .eq('organization_id', context.organizationId)
    .in('role', ['operator', 'boss'])
    .order('created_at')
  throwDatabaseError(error, 'No se pudieron leer los usuarios')

  return (data || []).map((row) => ({
    userId: row.user_id,
    username: row.username || '',
    displayName: row.display_name || '',
    role: row.role,
    active: Boolean(row.active),
    createdAt: row.created_at,
    jobTitle: row.job_title || '',
    department: row.department || '',
    requireQuizPhotoOverride: row.require_quiz_photo_override,
  }))
}

export async function createUser({ username, password, role, displayName, jobTitle, department }) {
  return withAdminSession((accessToken) => requestFunction(CREATE_USER_FUNCTION_URL, {
    body: { username, password, role, displayName, jobTitle, department },
    accessToken,
  }))
}

export async function updateUser({ userId, displayName, role, active, newPassword, jobTitle, department, requireQuizPhotoOverride }) {
  return withAdminSession((accessToken) => requestFunction(UPDATE_USER_FUNCTION_URL, {
    body: { userId, displayName, role, active, newPassword, jobTitle, department, requireQuizPhotoOverride },
    accessToken,
  }))
}

/**
 * Reporta el punto más lejano alcanzado en un video para el usuario actual,
 * más la señal `ended` cuando el reproductor confirma el fin de la
 * reproducción. El trigger de la base de datos decide si eso cuenta como
 * "visto" (100% de la duración real guardada en `videos`, o `ended`); aquí
 * solo enviamos segundos.
 */
export async function recordVideoProgress({ videoId, userId, progressSeconds, durationSeconds, ended = false }) {
  if (!videoId || !userId || !Number.isFinite(progressSeconds)) return
  const payload = {
    video_id: videoId,
    user_id: userId,
    max_progress_seconds: Math.max(0, Math.floor(progressSeconds)),
  }
  // Cuando el reproductor conoce la duración real (video nativo o YouTube),
  // se reporta para que el servidor pueda autocompletar videos.duration_seconds
  // si el admin la dejó en blanco al crear el video.
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    payload.reported_duration_seconds = Math.round(durationSeconds)
  }
  // Señal explícita de que el reproductor llegó al final (evento `ended` /
  // `ENDED`), para marcar "visto" aunque la duración guardada no coincida al
  // segundo exacto con la duración real del archivo.
  if (ended) payload.reported_ended = true
  const { data, error } = await getClient()
    .from('video_watch_progress')
    .upsert(payload, { onConflict: 'video_id,user_id' })
    .select('completed').single()
  throwDatabaseError(error, 'No se pudo guardar el progreso del video')
  return { completed: Boolean(data?.completed) }
}

export async function listWatchProgress() {
  const context = await getCurrentAccessContext()
  const { data, error } = await getClient()
    .from('video_watch_progress')
    .select('video_id,user_id,completed,max_progress_seconds,last_watched_at')
    .eq('organization_id', context.organizationId)
  throwDatabaseError(error, 'No se pudieron leer los progresos')

  return (data || []).map((row) => ({
    videoId: row.video_id,
    userId: row.user_id,
    completed: Boolean(row.completed),
    maxProgressSeconds: row.max_progress_seconds,
    lastWatchedAt: row.last_watched_at,
  }))
}

/**
 * Resultados de cuestionario. Con RLS, un admin recibe los de toda la
 * organización y un operante/jefe recibe únicamente los suyos, igual que
 * `listWatchProgress`.
 */
export async function listVideoQuizResults(videoId = null) {
  const context = await getCurrentAccessContext()
  let query = getClient()
    .from('video_quiz_results')
    .select('video_id,user_id,attempts_count,extra_attempts,best_score_percent,passed,last_attempt_at')
    .eq('organization_id', context.organizationId)
  if (videoId) query = query.eq('video_id', videoId)
  const { data, error } = await query
  throwDatabaseError(error, 'No se pudieron leer los cuestionarios respondidos')

  return (data || []).map((row) => ({
    videoId: row.video_id,
    userId: row.user_id,
    attemptsCount: row.attempts_count,
    extraAttempts: row.extra_attempts || 0,
    bestScorePercent: row.best_score_percent,
    passed: Boolean(row.passed),
    lastAttemptAt: row.last_attempt_at,
  }))
}

export async function grantQuizAttempt(videoId, userId) {
  const { data, error } = await getClient().rpc('admin_grant_quiz_attempt', {
    p_video_id: videoId,
    p_user_id: userId,
  })
  throwDatabaseError(error, 'No se pudo habilitar el intento adicional')
  return data
}

function mapQuizAttemptRow(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    userId: row.user_id,
    attemptNumber: row.attempt_number,
    scorePercent: row.score_percent,
    passed: Boolean(row.passed),
    createdAt: row.created_at,
    photoPath: row.photo_path || null,
    answers: (row.answers || []).map((answer) => ({
      questionId: answer.questionId,
      prompt: answer.prompt,
      selectedOptionId: answer.selectedOptionId || null,
      selectedLabel: answer.selectedLabel,
      isCorrect: Boolean(answer.isCorrect),
      correctLabel: answer.correctLabel,
    })),
  }
}

/**
 * Historial completo de intentos de cuestionario de un usuario (todos sus
 * videos), con el detalle de qué marcó en cada pregunta. Solo el propio
 * usuario o un admin de su organización pueden leerlo (RLS).
 */
export async function listQuizAttemptsForUser(userId) {
  const { data, error } = await getClient()
    .from('video_quiz_attempts')
    .select('id,video_id,user_id,attempt_number,score_percent,passed,answers,photo_path,created_at')
    .eq('user_id', userId)
    .order('video_id', { ascending: true })
    .order('attempt_number', { ascending: true })
  throwDatabaseError(error, 'No se pudo leer el historial de cuestionarios')

  return (data || []).map(mapQuizAttemptRow)
}

/**
 * Igual que `listQuizAttemptsForUser`, pero sin filtrar por usuario: con RLS,
 * un admin recibe los intentos de todos los usuarios de su organización
 * (usado para el reporte Excel). Un operante/jefe solo vería los suyos.
 */
export async function listAllQuizAttempts() {
  const context = await getCurrentAccessContext()
  const { data, error } = await getClient()
    .from('video_quiz_attempts')
    .select('id,video_id,user_id,attempt_number,score_percent,passed,answers,photo_path,created_at')
    .eq('organization_id', context.organizationId)
    .order('user_id', { ascending: true })
    .order('video_id', { ascending: true })
    .order('attempt_number', { ascending: true })
  throwDatabaseError(error, 'No se pudo leer el historial de cuestionarios')

  return (data || []).map(mapQuizAttemptRow)
}

function mapQuizPayload(payload) {
  if (!payload) return null
  return {
    videoId: payload.videoId,
    passingScorePercent: payload.passingScorePercent,
    maxAttempts: payload.maxAttempts ?? 3,
    attemptsCount: payload.attemptsCount || 0,
    extraAttempts: payload.extraAttempts || 0,
    remainingAttempts: payload.remainingAttempts,
    questions: (payload.questions || []).map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: (question.options || []).map((option) => ({
        id: option.id,
        label: option.label,
        ...(typeof option.isCorrect === 'boolean' ? { isCorrect: option.isCorrect } : {}),
      })),
    })),
  }
}

/** Cuestionario completo (incluye la respuesta correcta) para el editor administrativo. */
export async function getAdminVideoQuiz(videoId) {
  const { data, error } = await getClient().rpc('admin_get_video_quiz', { p_video_id: videoId })
  throwDatabaseError(error, 'No se pudo cargar el cuestionario')
  return mapQuizPayload(data)
}

/** Reemplaza por completo el cuestionario de un video de forma atómica. */
export async function saveVideoQuiz(videoId, { passingScorePercent, questions, maxAttempts = 3 }) {
  const { data, error } = await getClient().rpc('admin_save_video_quiz', {
    p_video_id: videoId,
    p_passing_score_percent: passingScorePercent,
    p_max_attempts: maxAttempts,
    p_questions: questions.map((question) => ({
      prompt: question.prompt,
      options: question.options.map((option) => ({
        label: option.label,
        isCorrect: Boolean(option.isCorrect),
      })),
    })),
  })
  throwDatabaseError(error, 'No se pudo guardar el cuestionario')
  return data
}

export async function deleteVideoQuiz(videoId) {
  const { error } = await getClient().rpc('admin_delete_video_quiz', { p_video_id: videoId })
  throwDatabaseError(error, 'No se pudo eliminar el cuestionario')
}

/** Cuestionario sin respuestas correctas, para que lo responda un usuario. */
export async function getPlayableVideoQuiz(videoId) {
  const { data, error } = await getClient().rpc('get_playable_video_quiz', { p_video_id: videoId })
  throwDatabaseError(error, 'No se pudo cargar el cuestionario')
  return mapQuizPayload(data)
}

/** Envía las respuestas; el servidor corrige y nunca confía en un puntaje calculado en el navegador. */
export async function submitVideoQuizAttempt(videoId, answers, photoPath = null, requestId = crypto.randomUUID()) {
  const { data, error } = await getClient().rpc('submit_video_quiz_attempt', {
    p_video_id: videoId,
    p_answers: answers.map((answer) => ({ questionId: answer.questionId, optionId: answer.optionId })),
    p_photo_path: photoPath || null,
    p_request_id: requestId,
  })
  throwDatabaseError(error, 'No se pudo enviar el cuestionario')
  return {
    scorePercent: data.scorePercent,
    correctCount: data.correctCount,
    totalQuestions: data.totalQuestions,
    passed: Boolean(data.passed),
    passingScorePercent: data.passingScorePercent,
    attemptsCount: data.attemptsCount,
    maxAttempts: data.maxAttempts,
    extraAttempts: data.extraAttempts || 0,
    remainingAttempts: data.remainingAttempts,
    bestScorePercent: data.bestScorePercent,
  }
}

const QUIZ_PHOTOS_BUCKET = 'quiz-photos'

/**
 * Sube la foto tomada justo antes de un intento de cuestionario. La ruta
 * codifica organización/usuario/video para que las políticas de Storage
 * puedan aplicar el mismo criterio "propio o admin" que el resto de las
 * tablas, sin depender de metadata adicional.
 */
export async function uploadQuizAttemptPhoto({ organizationId, userId, videoId, blob }) {
  if (!organizationId || !userId || !videoId || !blob) {
    throw new VideoHubApiError('Falta información para guardar la foto.', { code: 'INVALID_PHOTO_UPLOAD' })
  }
  const path = `${organizationId}/${userId}/${videoId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const { error } = await getClient().storage.from(QUIZ_PHOTOS_BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  throwDatabaseError(error, 'No se pudo guardar la foto')
  return path
}

/** URL firmada de corta duración para que el admin revise la foto de un intento. */
export async function getQuizAttemptPhotoUrl(photoPath) {
  if (!photoPath) return ''
  const { data, error } = await getClient().storage.from(QUIZ_PHOTOS_BUCKET).createSignedUrl(photoPath, 10 * 60)
  throwDatabaseError(error, 'No se pudo abrir la foto')
  return data?.signedUrl || ''
}

export function onAuthStateChange(callback) {
  const { data } = getClient().auth.onAuthStateChange((event, session) => callback(event, session))
  return () => data.subscription.unsubscribe()
}

export async function signOut(options = {}) {
  const { error } = await getClient().auth.signOut({ scope: options.scope || 'local' })
  throwDatabaseError(error, 'No se pudo cerrar la sesión')
}

export async function getCurrentAccessContext() {
  const { data, error } = await getClient().rpc('get_my_access_context')
  throwDatabaseError(error, 'No se pudo obtener el perfil de acceso')

  if (!data?.userId || !data?.organizationId || !data?.role) {
    throw new VideoHubApiError('La sesión no tiene un perfil activo asociado.', {
      code: 'PROFILE_NOT_FOUND',
    })
  }

  return {
    userId: data.userId,
    organizationId: data.organizationId,
    organization: data.organization || '',
    role: data.role,
    displayName: data.displayName || '',
    active: Boolean(data.active),
    contentRevision: Number.isSafeInteger(Number(data.contentRevision))
      ? Number(data.contentRevision)
      : 0,
  }
}

export async function setSectionContentType({ sectionId, organizationId, contentType }) {
  if (!isUuid(sectionId) || !isUuid(organizationId) || !['videos', 'documents'].includes(contentType)) {
    throw new VideoHubApiError('No se pudo cambiar el tipo de contenido de la sección.', {
      code: 'INVALID_SECTION_CONTENT_TYPE',
    })
  }
  const { data, error } = await getClient()
    .from('section_content_settings')
    .upsert({
      section_id: sectionId,
      organization_id: organizationId,
      content_type: contentType,
    }, { onConflict: 'section_id' })
    .select('content_type')
    .single()
  if (error?.message?.includes('SECTION_HAS_DOCUMENTS')) {
    throw new VideoHubApiError('Elimina primero los documentos de esta sección.', {
      code: 'SECTION_HAS_DOCUMENTS',
      cause: error,
    })
  }
  throwDatabaseError(error, 'No se pudo actualizar la sección')
  if (data?.content_type !== contentType) {
    throw new VideoHubApiError('Supabase no confirmó el cambio de la sección.', {
      code: 'SECTION_CONTENT_NOT_CONFIRMED',
    })
  }
  return data.content_type
}

export async function uploadSectionDocument({ organizationId, sectionId, title, file, audience = 'both' }) {
  const normalizedTitle = String(title || '').trim()
  const mimeType = resolveDocumentMimeType(file)
  if (!isUuid(organizationId) || !isUuid(sectionId) || !normalizedTitle) {
    throw new VideoHubApiError('Completa el título y la sección del documento.', {
      code: 'INVALID_DOCUMENT',
    })
  }
  if (!['operator', 'boss', 'both'].includes(audience)) {
    throw new VideoHubApiError('Selecciona un rol válido para el documento.', { code: 'INVALID_DOCUMENT_AUDIENCE' })
  }
  if (!file || !mimeType) {
    throw new VideoHubApiError('Selecciona un archivo PDF, DOC o DOCX válido.', {
      code: 'INVALID_DOCUMENT_FILE',
    })
  }
  if (file.size <= 0 || file.size > DOCUMENT_MAX_BYTES) {
    throw new VideoHubApiError('El documento debe pesar como máximo 25 MB.', {
      code: 'DOCUMENT_TOO_LARGE',
    })
  }

  const id = createUuid()
  const safeFileName = String(file.name || 'documento')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-180) || 'documento'
  const storageObjectPath = `${organizationId}/${sectionId}/${id}/${safeFileName}`
  const client = getClient()
  const { error: uploadError } = await client.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storageObjectPath, file, { contentType: mimeType, upsert: false })
  throwDatabaseError(uploadError, 'No se pudo subir el documento')

  const { data, error } = await client
    .from('section_documents')
    .insert({
      id,
      organization_id: organizationId,
      section_id: sectionId,
      audience,
      title: normalizedTitle,
      file_name: file.name,
      mime_type: mimeType,
      file_size: file.size,
      storage_bucket: DOCUMENTS_BUCKET,
      storage_object_path: storageObjectPath,
    })
    .select('id,organization_id,section_id,audience,title,file_name,mime_type,file_size,storage_bucket,storage_object_path,sort_order,created_at')
    .single()

  if (error) {
    await client.storage.from(DOCUMENTS_BUCKET).remove([storageObjectPath]).catch(() => undefined)
    throwDatabaseError(error, 'No se pudo registrar el documento')
  }
  return mapDocumentRow(data)
}

export async function updateSectionDocumentTitle(documentId, title) {
  const normalizedTitle = String(title || '').trim()
  if (!isUuid(documentId) || !normalizedTitle) {
    throw new VideoHubApiError('Escribe un título válido.', { code: 'INVALID_DOCUMENT_TITLE' })
  }
  const { data, error } = await getClient()
    .from('section_documents')
    .update({ title: normalizedTitle })
    .eq('id', documentId)
    .select('id,organization_id,section_id,audience,title,file_name,mime_type,file_size,storage_bucket,storage_object_path,sort_order,created_at')
    .single()
  throwDatabaseError(error, 'No se pudo editar el documento')
  return mapDocumentRow(data)
}

export async function updateSectionDocumentAudience(documentId, audience) {
  if (!isUuid(documentId) || !['operator', 'boss', 'both'].includes(audience)) {
    throw new VideoHubApiError('Selecciona un rol válido para el documento.', { code: 'INVALID_DOCUMENT_AUDIENCE' })
  }
  const { data, error } = await getClient()
    .from('section_documents')
    .update({ audience })
    .eq('id', documentId)
    .select('id,organization_id,section_id,audience,title,file_name,mime_type,file_size,storage_bucket,storage_object_path,sort_order,created_at')
    .single()
  throwDatabaseError(error, 'No se pudo cambiar la visibilidad del documento')
  return mapDocumentRow(data)
}

export async function deleteSectionDocument(document) {
  if (!isUuid(document?.id) || !document.storageBucket || !document.storageObjectPath) {
    throw new VideoHubApiError('El documento no es válido.', { code: 'INVALID_DOCUMENT' })
  }
  const client = getClient()
  const { error: storageError } = await client.storage
    .from(document.storageBucket)
    .remove([document.storageObjectPath])
  throwDatabaseError(storageError, 'No se pudo borrar el archivo')
  const { data, error } = await client.from('section_documents').delete().eq('id', document.id).select('id').single()
  throwDatabaseError(error, 'No se pudo borrar el documento')
  if (data?.id !== document.id) {
    throw new VideoHubApiError('Supabase no confirmó la eliminación del documento.', {
      code: 'DOCUMENT_DELETE_NOT_CONFIRMED',
    })
  }
}

export async function getSectionDocumentViewUrl(document) {
  if (!document?.storageBucket || !document.storageObjectPath) {
    throw new VideoHubApiError('El documento no tiene un archivo disponible.', {
      code: 'INVALID_DOCUMENT',
    })
  }
  const { data, error } = await getClient().storage
    .from(document.storageBucket)
    .createSignedUrl(document.storageObjectPath, 60 * 60)
  throwDatabaseError(error, 'No se pudo abrir el documento')
  return data?.signedUrl || ''
}

/**
 * Carga una vista completa desde Supabase. Las políticas RLS determinan qué
 * secciones, tarjetas, asignaciones y enlaces recibe cada rol.
 */
export async function loadVideoHubSnapshot(options = {}) {
  const client = getClient()
  const context = options.context || await getCurrentAccessContext()
  const organizationId = context.organizationId
  const previousVideoById = new Map(
    (options.previousSnapshot?.videos || []).map((video) => [video.id, video]),
  )

  const [organizationResult, settingsResult, sectionsResult, rolesResult, videosResult, assignmentsResult, quizzesResult, myProgressResult, myQuizResultsResult, sectionContentResult, documentsResult, myProfileResult] = await Promise.all([
    client.from('organizations').select('id,name,slug,logo_url').eq('id', organizationId).single(),
    client.from('app_settings').select('product_name,welcome_title,welcome_message,support_message,allow_light_mode,require_quiz_photo').eq('organization_id', organizationId).maybeSingle(),
    client.from('sections').select('id,name,slug,icon,sort_order,created_at').eq('organization_id', organizationId).eq('active', true).order('sort_order'),
    client.from('section_roles').select('section_id,role,visible').eq('organization_id', organizationId),
    client.from('videos').select('id,title,description,duration_label,duration_seconds,featured,created_at').eq('organization_id', organizationId).eq('active', true).order('created_at', { ascending: false }),
    client.from('video_assignments').select('video_id,role,section_id,visible,is_locked,prerequisite_video_id,sort_order').eq('organization_id', organizationId),
    client.from('video_quizzes').select('video_id,passing_score_percent,question_count,max_attempts').eq('organization_id', organizationId),
    client.from('video_watch_progress').select('video_id,completed').eq('organization_id', organizationId).eq('user_id', context.userId),
    client.from('video_quiz_results').select('video_id,attempts_count,extra_attempts,best_score_percent,passed').eq('organization_id', organizationId).eq('user_id', context.userId),
    client.from('section_content_settings').select('section_id,content_type').eq('organization_id', organizationId),
    client.from('section_documents').select('id,organization_id,section_id,audience,title,file_name,mime_type,file_size,storage_bucket,storage_object_path,sort_order,created_at').eq('organization_id', organizationId).eq('active', true).order('sort_order').order('created_at', { ascending: false }),
    client.from('profiles').select('require_quiz_photo_override').eq('user_id', context.userId).single(),
  ])

  throwDatabaseError(organizationResult.error, 'No se pudo leer la organización')
  throwDatabaseError(settingsResult.error, 'No se pudo leer la configuración')
  throwDatabaseError(myProfileResult.error, 'No se pudo leer la configuración personal')
  throwDatabaseError(sectionsResult.error, 'No se pudieron leer las secciones')
  throwDatabaseError(rolesResult.error, 'No se pudieron leer los permisos de secciones')
  throwDatabaseError(videosResult.error, 'No se pudieron leer los videos')
  throwDatabaseError(assignmentsResult.error, 'No se pudieron leer los permisos de videos')
  throwDatabaseError(myProgressResult.error, 'No se pudo leer tu progreso')
  // Los cuestionarios son una función opcional que depende de una migración
  // aparte (video_quizzes / video_quiz_results). Si esa migración todavía no
  // se aplicó en este proyecto de Supabase, estas dos consultas fallan con
  // "tabla no encontrada"; en vez de tumbar toda la carga (login, videos,
  // secciones), se degrada a "sin cuestionarios" y el resto de la app sigue
  // funcionando con normalidad.
  if (quizzesResult.error) console.warn('No se pudieron leer los cuestionarios (¿falta aplicar la migración?):', quizzesResult.error.message)
  if (myQuizResultsResult.error) console.warn('No se pudieron leer tus cuestionarios (¿falta aplicar la migración?):', myQuizResultsResult.error.message)

  if (sectionContentResult.error) console.warn('No se pudo leer el tipo de contenido de las secciones:', sectionContentResult.error.message)
  if (documentsResult.error) console.warn('No se pudieron leer los documentos:', documentsResult.error.message)

  const sectionRows = sectionsResult.data || []
  const videoRows = videosResult.data || []
  const sectionIds = new Set(sectionRows.map((section) => section.id))
  const videoIds = new Set(videoRows.map((video) => video.id))
  const roleRows = (rolesResult.data || []).filter((row) => sectionIds.has(row.section_id))
  const assignmentRows = (assignmentsResult.data || []).filter(
    (row) => videoIds.has(row.video_id) && sectionIds.has(row.section_id),
  )
  const sourceRows = await selectRowsByIds(
    'video_sources',
    'video_id',
    [...videoIds],
    'video_id,provider,source_ref,source_url,thumbnail_url,storage_bucket,storage_object_path,metadata',
  )
  const sourceByVideo = new Map(sourceRows.map((source) => [source.video_id, source]))
  const resolvedSourceEntries = await Promise.all(
    sourceRows.map(async (source) => [
      source.video_id,
      await resolveSourceUrl(source, previousVideoById.get(source.video_id)),
    ]),
  )
  const resolvedUrlByVideo = new Map(resolvedSourceEntries)
  const quizByVideo = new Map((quizzesResult.data || []).map((row) => [row.video_id, row]))
  const myProgressByVideo = new Map((myProgressResult.data || []).map((row) => [row.video_id, row]))
  const myQuizResultByVideo = new Map((myQuizResultsResult.data || []).map((row) => [row.video_id, row]))
  const contentTypeBySection = new Map((sectionContentResult.data || []).map((row) => [row.section_id, row.content_type]))

  const sections = sectionRows.map((section) => ({
    id: section.id,
    name: section.name,
    slug: section.slug,
    icon: section.icon,
    roles: roleRows
      .filter((row) => row.section_id === section.id && row.visible && VIEWER_ROLES.includes(row.role))
      .map((row) => row.role),
    order: section.sort_order,
    contentType: contentTypeBySection.get(section.id) === 'documents' ? 'documents' : 'videos',
    createdAt: section.created_at,
  }))

  const videos = videoRows.map((video) => {
    const assignments = {}
    const locked = {}
    const prerequisites = {}
    assignmentRows
      .filter((row) => row.video_id === video.id && row.visible && VIEWER_ROLES.includes(row.role))
      .forEach((row) => {
        assignments[row.role] = row.section_id
        locked[row.role] = Boolean(row.is_locked)
        if (row.prerequisite_video_id) prerequisites[row.role] = row.prerequisite_video_id
      })

    const source = sourceByVideo.get(video.id)
    const resolvedSource = resolvedUrlByVideo.get(video.id) || { url: '', expiresAt: null }
    const resolvedUrl = resolvedSource.url
    const quizRow = quizByVideo.get(video.id)
    const quizResultRow = myQuizResultByVideo.get(video.id)
    return {
      id: video.id,
      title: video.title,
      description: video.description || '',
      url: resolvedUrl,
      thumbnailUrl: source?.thumbnail_url || '',
      duration: video.duration_label || formatDuration(video.duration_seconds),
      assignments,
      locked,
      prerequisites,
      featured: Boolean(video.featured),
      createdAt: video.created_at,
      watched: Boolean(myProgressByVideo.get(video.id)?.completed),
      quiz: quizRow ? {
        passingScorePercent: quizRow.passing_score_percent,
        questionCount: quizRow.question_count,
        maxAttempts: quizRow.max_attempts,
      } : null,
      quizResult: quizResultRow ? {
        attemptsCount: quizResultRow.attempts_count,
        extraAttempts: quizResultRow.extra_attempts || 0,
        bestScorePercent: quizResultRow.best_score_percent,
        passed: Boolean(quizResultRow.passed),
      } : null,
      source: source ? {
        provider: source.provider,
        sourceRef: source.source_ref,
        sourceUrl: source.source_url || '',
        resolvedUrl,
        thumbnailUrl: source.thumbnail_url || '',
        storageBucket: source.storage_bucket || '',
        storageObjectPath: source.storage_object_path || '',
        signedUrlExpiresAt: resolvedSource.expiresAt,
        metadata: source.metadata || {},
      } : null,
    }
  })

  return {
    organization: organizationResult.data?.name || context.organization || '',
    organizationId,
    revision: Number.isSafeInteger(Number(context.contentRevision))
      ? Number(context.contentRevision)
      : 0,
    logoUrl: organizationResult.data?.logo_url || '',
    settings: {
      ...mapSettings(settingsResult.data),
      requireQuizPhoto: myProfileResult.data?.require_quiz_photo_override ?? Boolean(settingsResult.data?.require_quiz_photo),
    },
    sections,
    videos: VIEWER_ROLES.includes(context.role) ? withLearningAccess(videos, sections, context.role) : videos,
    documents: (documentsResult.data || [])
      .filter((document) => sectionIds.has(document.section_id))
      .map(mapDocumentRow),
    context,
  }
}

function prepareSnapshot(snapshot, organizationId, existingSections) {
  const sequenceError = validateLearningSequence(snapshot?.videos || [], snapshot?.sections || [])
  if (sequenceError) throw new VideoHubApiError(sequenceError, { code: 'INVALID_LEARNING_SEQUENCE' })
  if (!Array.isArray(snapshot?.sections) || !Array.isArray(snapshot?.videos)) {
    throw new VideoHubApiError('El snapshot debe incluir listas de secciones y videos.', {
      code: 'INVALID_SNAPSHOT',
    })
  }

  const existingSectionById = new Map(existingSections.map((section) => [section.id, section]))
  const existingSlugOwner = new Map(existingSections.map((section) => [section.slug, section.id]))
  const sectionIdMap = new Map()
  const usedInputSectionIds = new Set()

  snapshot.sections.forEach((section, index) => {
    const inputId = String(section.id || `new-section-${index}`)
    if (usedInputSectionIds.has(inputId)) {
      throw new VideoHubApiError(`La sección “${section.name || inputId}” tiene un identificador duplicado.`, {
        code: 'DUPLICATE_SECTION_ID',
      })
    }
    usedInputSectionIds.add(inputId)
    sectionIdMap.set(inputId, isUuid(section.id) ? section.id : createUuid())
  })

  const selectedSlugs = new Set()
  const sectionRows = snapshot.sections.map((section, index) => {
    const inputId = String(section.id || `new-section-${index}`)
    const id = sectionIdMap.get(inputId)
    const name = String(section.name || '').trim()
    if (!name) {
      throw new VideoHubApiError('Todas las secciones necesitan un nombre.', {
        code: 'INVALID_SECTION',
      })
    }

    const storedSlug = existingSectionById.get(id)?.slug
    const requestedSlug = SLUG_PATTERN.test(String(section.slug || '')) ? section.slug : ''
    const baseSlug = storedSlug || requestedSlug || slugify(name)
    let slug = baseSlug
    let suffix = 2
    while (
      selectedSlugs.has(slug)
      || (existingSlugOwner.has(slug) && existingSlugOwner.get(slug) !== id)
    ) {
      slug = `${baseSlug}-${suffix}`
      suffix += 1
    }
    selectedSlugs.add(slug)

    return {
      id,
      organization_id: organizationId,
      name,
      slug,
      icon: String(section.icon || 'layers').trim() || 'layers',
      sort_order: Number.isInteger(section.order) && section.order >= 0 ? section.order : index,
      active: true,
    }
  })

  const sectionRoleRows = snapshot.sections.flatMap((section, index) => {
    const inputId = String(section.id || `new-section-${index}`)
    const sectionId = sectionIdMap.get(inputId)
    return VIEWER_ROLES.map((role) => ({
      section_id: sectionId,
      organization_id: organizationId,
      role,
      visible: Array.isArray(section.roles) && section.roles.includes(role),
    }))
  })

  const videoIdMap = new Map()
  const usedInputVideoIds = new Set()
  snapshot.videos.forEach((video, index) => {
    const inputId = String(video.id || `new-video-${index}`)
    if (usedInputVideoIds.has(inputId)) {
      throw new VideoHubApiError(`El video “${video.title || inputId}” tiene un identificador duplicado.`, {
        code: 'DUPLICATE_VIDEO_ID',
      })
    }
    usedInputVideoIds.add(inputId)
    videoIdMap.set(inputId, isUuid(video.id) ? video.id : createUuid())
  })

  const videoRows = []
  const sourceRows = []
  const assignmentRows = []

  snapshot.videos.forEach((video, index) => {
    const inputId = String(video.id || `new-video-${index}`)
    const id = videoIdMap.get(inputId)
    const title = String(video.title || '').trim()
    if (!title) {
      throw new VideoHubApiError('Todos los videos necesitan un título.', {
        code: 'INVALID_VIDEO',
      })
    }

    const duration = String(video.duration || 'Video').trim().slice(0, 20) || 'Video'
    const createdAt = Number.isNaN(Date.parse(video.createdAt)) ? new Date().toISOString() : video.createdAt
    videoRows.push({
      id,
      organization_id: organizationId,
      title,
      description: String(video.description || '').trim(),
      duration_label: duration,
      duration_seconds: parseDurationSeconds(duration),
      featured: Boolean(video.featured),
      active: true,
      created_at: createdAt,
    })

    const previousSource = video.source
    const currentUrl = String(video.url || '').trim()
    const sourceWasNotChanged = previousSource && (
      currentUrl === String(previousSource.resolvedUrl || '')
      || currentUrl === String(previousSource.sourceUrl || '')
      || (previousSource.provider === 'supabase_storage' && !currentUrl)
    )

    if (sourceWasNotChanged && DATABASE_PROVIDERS.has(previousSource.provider)) {
      sourceRows.push({
        video_id: id,
        provider: previousSource.provider,
        source_ref: String(previousSource.sourceRef || previousSource.storageObjectPath || previousSource.sourceUrl || '').trim(),
        source_url: previousSource.provider === 'supabase_storage' ? null : previousSource.sourceUrl,
        thumbnail_url: /^https:\/\//i.test(String(video.thumbnailUrl || '')) ? video.thumbnailUrl.trim() : null,
        storage_bucket: previousSource.provider === 'supabase_storage' ? previousSource.storageBucket : null,
        storage_object_path: previousSource.provider === 'supabase_storage' ? previousSource.storageObjectPath : null,
        metadata: previousSource.metadata && typeof previousSource.metadata === 'object' ? previousSource.metadata : {},
      })
    } else {
      const parsedSource = getVideoSource(currentUrl)
      if (!currentUrl || ['empty', 'invalid'].includes(parsedSource.type) || !/^https:\/\//i.test(currentUrl)) {
        throw new VideoHubApiError(`El enlace del video “${title}” debe ser una URL HTTPS válida.`, {
          code: 'INVALID_VIDEO_URL',
        })
      }
      const provider = DATABASE_PROVIDERS.has(parsedSource.provider) ? parsedSource.provider : 'direct'
      sourceRows.push({
        video_id: id,
        provider,
        source_ref: String(parsedSource.id || currentUrl).trim(),
        source_url: currentUrl,
        thumbnail_url: /^https:\/\//i.test(String(video.thumbnailUrl || '')) ? video.thumbnailUrl.trim() : null,
        storage_bucket: null,
        storage_object_path: null,
        metadata: {},
      })
    }

    VIEWER_ROLES.forEach((role) => {
      const inputSectionId = video.assignments?.[role]
      if (!inputSectionId) return
      const sectionId = sectionIdMap.get(String(inputSectionId))
      if (!sectionId) {
        throw new VideoHubApiError(`El video “${title}” apunta a una sección que ya no existe.`, {
          code: 'INVALID_VIDEO_ASSIGNMENT',
        })
      }
      assignmentRows.push({
        video_id: id,
        organization_id: organizationId,
        role,
        section_id: sectionId,
        visible: true,
        is_locked: Boolean(video.locked?.[role]),
        prerequisite_video_id: video.prerequisites?.[role] || null,
        sort_order: index,
      })
    })
  })

  for (const source of sourceRows) {
    if (!source.source_ref) {
      throw new VideoHubApiError('Cada video necesita una fuente válida.', {
        code: 'INVALID_VIDEO_SOURCE',
      })
    }
    if (source.provider === 'supabase_storage' && (!source.storage_bucket || !source.storage_object_path)) {
      throw new VideoHubApiError('La fuente de Storage está incompleta.', {
        code: 'INVALID_STORAGE_SOURCE',
      })
    }
  }

  return { sectionRows, sectionRoleRows, videoRows, sourceRows, assignmentRows }
}

/**
 * Sincroniza el estado administrativo únicamente mediante la Function de
 * Netlify y la RPC atómica de Supabase. Devuelve el snapshot confirmado por la
 * base de datos, con los UUID definitivos.
 */
export async function saveAdminSnapshot(snapshot, options = {}) {
  const client = getClient()
  const context = options.context || await getCurrentAccessContext()
  if (context.role !== 'admin') {
    throw new VideoHubApiError('Solo un administrador puede guardar la configuración.', {
      code: 'ADMIN_REQUIRED',
    })
  }

  const organizationId = context.organizationId
  const existingSectionsResult = await client
    .from('sections')
    .select('id,slug,active')
    .eq('organization_id', organizationId)
  throwDatabaseError(existingSectionsResult.error, 'No se pudo preparar la sincronización de secciones')

  // Validar y transformar todo antes de efectuar la primera escritura.
  const prepared = prepareSnapshot(snapshot, organizationId, existingSectionsResult.data || [])

  const organizationName = String(snapshot.organization || '').trim()
  const logoUrl = String(snapshot.logoUrl || '').trim()
  const normalizedSettings = snapshot.settings ? {
    product_name: String(snapshot.settings.productName || 'Video Hub').trim() || 'Video Hub',
    welcome_title: String(snapshot.settings.welcomeTitle || 'Video Hub').trim() || 'Video Hub',
    welcome_message: String(snapshot.settings.welcomeMessage || '').trim(),
    support_message: String(snapshot.settings.supportMessage || '').trim(),
    allow_light_mode: snapshot.settings.allowLightMode !== false,
    require_quiz_photo: Boolean(snapshot.settings.requireQuizPhoto),
  } : null

  const session = await getCurrentSession()
  if (!session?.access_token) {
    throw new VideoHubApiError('La sesión administrativa ya no es válida.', {
      code: 'SESSION_REQUIRED',
    })
  }

  const atomicSave = await requestFunction(SAVE_SNAPSHOT_FUNCTION_URL, {
    accessToken: session.access_token,
    body: {
      expectedRevision: Number.isSafeInteger(Number(snapshot.revision))
        ? Number(snapshot.revision)
        : 0,
      snapshot: {
      organization: organizationName,
      logo_url: logoUrl,
      settings: normalizedSettings,
      sections: prepared.sectionRows,
      section_roles: prepared.sectionRoleRows,
      videos: prepared.videoRows,
      video_sources: prepared.sourceRows,
      video_assignments: prepared.assignmentRows,
      },
    },
  })

  if (!atomicSave.ok) {
    throw new VideoHubApiError('No se pudo guardar la configuración.', {
      code: 'ATOMIC_SAVE_FAILED',
    })
  }

  const driveVideoIds = prepared.sourceRows
    .filter((source) => source.provider === 'google_drive')
    .map((source) => source.video_id)
  if (driveVideoIds.length && atomicSave.drive_import_queued !== true) {
    // La importación ocurre en segundo plano. Si se interrumpe, el enlace de
    // Drive ya guardado sigue funcionando y un próximo guardado vuelve a intentar.
    await dispatchDriveVideoImports(driveVideoIds, session.access_token)
  }

  const savedContext = {
    ...context,
    contentRevision: Number.isSafeInteger(Number(atomicSave.revision))
      ? Number(atomicSave.revision)
      : Number(snapshot.revision || 0) + 1,
  }
  return loadVideoHubSnapshot({ context: savedContext })
}
