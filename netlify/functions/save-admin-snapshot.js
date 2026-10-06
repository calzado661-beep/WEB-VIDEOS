import { jsonResponse, methodNotAllowed, readBearerToken, readJsonBody } from './_shared/http.js'
import {
  createUserClient,
  getServerConfiguration,
  ServerConfigurationError,
} from './_shared/supabase-server.js'

const DRIVE_IMPORT_FUNCTION_PATH = '/.netlify/functions/import-drive-videos'
const MAX_QUEUED_DRIVE_IMPORTS = 10

async function queueDriveImports(request, accessToken, snapshot) {
  const videoIds = [...new Set(
    (Array.isArray(snapshot?.video_sources) ? snapshot.video_sources : [])
      .filter((source) => source?.provider === 'google_drive' && source?.video_id)
      .map((source) => String(source.video_id)),
  )].slice(0, MAX_QUEUED_DRIVE_IMPORTS)
  if (!videoIds.length) return true

  const functionUrl = new URL(DRIVE_IMPORT_FUNCTION_PATH, request.url).toString()
  const requests = await Promise.allSettled(videoIds.map((videoId) => fetch(functionUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ videoIds: [videoId] }),
  })))

  return requests.every((result) => result.status === 'fulfilled' && result.value.ok)
}

export default async function saveAdminSnapshot(request) {
  if (request.method !== 'POST') return methodNotAllowed()

  try {
    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
      return jsonResponse({ error: 'Origen no permitido.' }, 403)
    }

    const accessToken = readBearerToken(request)
    if (!accessToken) return jsonResponse({ error: 'Sesión no válida.' }, 401)

    const body = await readJsonBody(request)
    const snapshot = body?.snapshot
    const expectedRevision = Number(body?.expectedRevision)
    if (
      !snapshot
      || typeof snapshot !== 'object'
      || Array.isArray(snapshot)
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0
    ) {
      return jsonResponse({ error: 'Configuración no válida.' }, 400)
    }

    const configuration = getServerConfiguration()
    // Antes se validaba la sesión (auth.getUser) y el rol de administrador
    // (getAccessContext) con dos llamadas RPC adicionales antes de intentar
    // guardar. Ambas eran redundantes: save_admin_snapshot ya exige una
    // sesión valida y rol admin dentro del propio SQL (is_admin_for), y
    // PostgREST ya rechaza un token invalido antes de ejecutar la función.
    // Quitar esas dos vueltas de red extra reduce el tiempo total lo
    // suficiente para no chocar con el límite de ejecución de Netlify.
    const userClient = createUserClient(accessToken, configuration)
    const { data: savedRevision, error } = await userClient.rpc('save_admin_snapshot', {
      p_snapshot: snapshot,
      p_expected_revision: expectedRevision,
    })

    if (error) {
      if (error.code === 'VL001') return jsonResponse({ error: error.message, code: error.code }, 400)
      const missingRpc = error.code === 'PGRST202'
        || (/save_admin_snapshot/i.test(String(error.message || ''))
          && /not find|does not exist/i.test(String(error.message || '')))
      if (missingRpc) {
        return jsonResponse({
          error: 'Falta instalar la función de guardado en Supabase.',
          code: 'SUPABASE_SCHEMA_MISSING',
        }, 503)
      }
      if (error.code === 'VH001' || error.message === 'STALE_SNAPSHOT') {
        return jsonResponse({
          error: 'Supabase tiene cambios más recientes. Recarga antes de volver a editar.',
          code: 'STALE_SNAPSHOT',
        }, 409)
      }
      if (error.code === '55P03' || error.message === 'SAVE_BUSY') {
        return jsonResponse({
          error: 'Hay otro guardado en curso para esta organización. Inténtalo de nuevo en unos segundos.',
          code: 'SAVE_BUSY',
        }, 409)
      }
      const status = error.code === '42501'
        ? 403
        : ['21000', '22007', '22023', '22P02', '54000'].includes(error.code)
          ? 400
          : ['23503', '23505', '23514'].includes(error.code)
            ? 409
            : 503
      return jsonResponse({
        error: status === 503
          ? 'Supabase no pudo guardar la configuración.'
          : 'La configuración contiene datos que no se pueden guardar.',
      }, status)
    }

    const revision = Number(savedRevision)
    if (!Number.isSafeInteger(revision) || revision <= expectedRevision) {
      return jsonResponse({ error: 'Supabase no confirmó la versión guardada.' }, 503)
    }

    const driveImportQueued = await queueDriveImports(request, accessToken, snapshot)
      .catch(() => false)

    return jsonResponse({ ok: true, revision, drive_import_queued: driveImportQueued })
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return jsonResponse({
        error: 'Falta configurar Supabase en Netlify.',
        code: error.code,
        missing_variables: error.missingVariables,
      }, 503)
    }
    return jsonResponse({ error: 'El servicio de guardado no está disponible.' }, 500)
  }
}
