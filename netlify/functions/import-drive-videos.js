import { createHash } from 'node:crypto'
import { readBearerToken, readJsonBody } from './_shared/http.js'
import {
  createServerClients,
  createUserClient,
  getAccessContext,
  getServerConfiguration,
} from './_shared/supabase-server.js'

const STORAGE_BUCKET = 'video-assets'
const DEFAULT_MAX_IMPORT_BYTES = 50 * 1024 * 1024
const HARD_MAX_IMPORT_BYTES = 50 * 1024 * 1024
const MAX_VIDEO_IDS = 1
const MAX_REDIRECTS = 5
const MAX_FINALIZE_ATTEMPTS = 3
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DRIVE_FILE_ID_PATTERN = /^[a-z0-9_-]{10,256}$/i
const MIME_EXTENSIONS = new Map([
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/ogg', 'ogg'],
])

export const config = { background: true }

export function normalizeVideoIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => UUID_PATTERN.test(item)),
  )].slice(0, MAX_VIDEO_IDS)
}

export function getDriveDownloadUrl(sourceRef, sourceUrl = '') {
  const normalizedRef = String(sourceRef || '').trim()
  if (!DRIVE_FILE_ID_PATTERN.test(normalizedRef)) return ''
  const url = new URL('https://drive.usercontent.google.com/download')
  url.searchParams.set('id', normalizedRef)
  url.searchParams.set('export', 'download')
  url.searchParams.set('authuser', '0')
  url.searchParams.set('confirm', 't')

  try {
    const originalUrl = new URL(sourceUrl)
    const resourceKey = originalUrl.searchParams.get('resourcekey') || ''
    if (
      originalUrl.hostname.toLowerCase() === 'drive.google.com'
      && /^[a-z0-9_-]{6,256}$/i.test(resourceKey)
    ) url.searchParams.set('resourcekey', resourceKey)
  } catch {
    // Los enlaces antiguos sin resourcekey siguen siendo válidos.
  }

  return url.toString()
}

export function getVideoExtension(contentType) {
  return MIME_EXTENSIONS.get(String(contentType || '').split(';')[0].trim().toLowerCase()) || ''
}

export function getStorageObjectPath(videoId, sourceRef, extension) {
  const fingerprint = createHash('sha256').update(String(sourceRef), 'utf8').digest('hex').slice(0, 16)
  return `${videoId}/drive-${fingerprint}.${extension}`
}

function getMaximumImportBytes() {
  const configured = Number(process.env.DRIVE_IMPORT_MAX_BYTES)
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MAX_IMPORT_BYTES
  return Math.min(configured, HARD_MAX_IMPORT_BYTES)
}

function isAllowedGoogleDownloadHost(value) {
  let hostname
  try {
    hostname = new URL(value).hostname.toLowerCase()
  } catch {
    return false
  }
  return hostname === 'drive.usercontent.google.com'
    || hostname === 'drive.google.com'
    || hostname.endsWith('.googleusercontent.com')
}

async function fetchDriveResponse(sourceRef, sourceUrl) {
  let currentUrl = getDriveDownloadUrl(sourceRef, sourceUrl)
  if (!currentUrl) throw new Error('INVALID_DRIVE_FILE_ID')

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        accept: 'video/mp4,video/webm,video/ogg;q=0.9,*/*;q=0.1',
        'user-agent': 'VideoHubDriveImporter/1.0',
      },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('DRIVE_REDIRECT_WITHOUT_LOCATION')
      const nextUrl = new URL(location, currentUrl).toString()
      if (!isAllowedGoogleDownloadHost(nextUrl)) throw new Error('DRIVE_REDIRECT_NOT_ALLOWED')
      await response.body?.cancel()
      currentUrl = nextUrl
      continue
    }

    if (!response.ok) throw new Error(`DRIVE_DOWNLOAD_HTTP_${response.status}`)
    if (!isAllowedGoogleDownloadHost(response.url || currentUrl)) {
      throw new Error('DRIVE_DOWNLOAD_HOST_NOT_ALLOWED')
    }
    return response
  }

  throw new Error('DRIVE_TOO_MANY_REDIRECTS')
}

async function readResponseWithinLimit(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    throw new Error('DRIVE_VIDEO_TOO_LARGE')
  }
  if (!response.body) throw new Error('DRIVE_VIDEO_EMPTY')

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maximumBytes) {
      await reader.cancel()
      throw new Error('DRIVE_VIDEO_TOO_LARGE')
    }
    chunks.push(Buffer.from(value))
  }

  if (!totalBytes) throw new Error('DRIVE_VIDEO_EMPTY')
  return Buffer.concat(chunks, totalBytes)
}

function requireResult(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`)
  return result.data
}

export async function readAdminSnapshot(serviceClient, organizationId) {
  const [organizationResult, settingsResult, sectionsResult, rolesResult, videosResult, assignmentsResult] = await Promise.all([
    serviceClient.from('organizations').select('id,name,logo_url,content_revision').eq('id', organizationId).single(),
    serviceClient.from('app_settings').select('product_name,welcome_title,welcome_message,support_message,allow_light_mode,require_quiz_photo').eq('organization_id', organizationId).maybeSingle(),
    serviceClient.from('sections').select('id,name,slug,icon,sort_order,active').eq('organization_id', organizationId).eq('active', true).order('sort_order'),
    serviceClient.from('section_roles').select('section_id,role,visible').eq('organization_id', organizationId),
    serviceClient.from('videos').select('id,title,description,duration_label,duration_seconds,featured,active,created_at').eq('organization_id', organizationId).eq('active', true).order('created_at'),
    serviceClient.from('video_assignments').select('video_id,role,section_id,visible,is_locked,prerequisite_video_id,sort_order').eq('organization_id', organizationId),
  ])

  const organization = requireResult(organizationResult, 'READ_ORGANIZATION')
  const settings = requireResult(settingsResult, 'READ_SETTINGS')
  const sections = requireResult(sectionsResult, 'READ_SECTIONS') || []
  const videos = requireResult(videosResult, 'READ_VIDEOS') || []
  const sectionIds = new Set(sections.map((section) => section.id))
  const videoIds = videos.map((video) => video.id)
  const activeVideoIds = new Set(videoIds)
  const roles = (requireResult(rolesResult, 'READ_SECTION_ROLES') || [])
    .filter((role) => sectionIds.has(role.section_id))
  const assignments = (requireResult(assignmentsResult, 'READ_VIDEO_ASSIGNMENTS') || [])
    .filter((assignment) => activeVideoIds.has(assignment.video_id) && sectionIds.has(assignment.section_id))

  let sources = []
  if (videoIds.length) {
    sources = requireResult(
      await serviceClient
        .from('video_sources')
        .select('video_id,provider,source_ref,source_url,thumbnail_url,storage_bucket,storage_object_path,metadata')
        .in('video_id', videoIds),
      'READ_VIDEO_SOURCES',
    ) || []
  }

  return {
    revision: Number(organization.content_revision),
    snapshot: {
      organization: organization.name,
      logo_url: organization.logo_url,
      settings,
      sections,
      section_roles: roles,
      videos,
      video_sources: sources,
      video_assignments: assignments,
    },
  }
}

async function finalizeImportedSource({
  serviceClient,
  userClient,
  organizationId,
  videoId,
  expectedSourceRef,
  storageObjectPath,
  contentType,
  byteLength,
}) {
  for (let attempt = 0; attempt < MAX_FINALIZE_ATTEMPTS; attempt += 1) {
    const state = await readAdminSnapshot(serviceClient, organizationId)
    const source = state.snapshot.video_sources.find((item) => item.video_id === videoId)

    if (
      source?.provider === 'supabase_storage'
      && source.storage_bucket === STORAGE_BUCKET
      && source.storage_object_path === storageObjectPath
    ) return true

    if (source?.provider !== 'google_drive' || source.source_ref !== expectedSourceRef) return false

    const importedAt = new Date().toISOString()
    state.snapshot.video_sources = state.snapshot.video_sources.map((item) => (
      item.video_id === videoId
        ? {
          ...item,
          provider: 'supabase_storage',
          source_ref: storageObjectPath,
          source_url: null,
          storage_bucket: STORAGE_BUCKET,
          storage_object_path: storageObjectPath,
          metadata: {
            ...(item.metadata || {}),
            originalProvider: 'google_drive',
            originalSourceRef: item.source_ref,
            originalSourceUrl: item.source_url,
            importedAt,
            importStatus: 'complete',
            contentType,
            byteLength,
          },
        }
        : item
    ))

    const { error } = await userClient.rpc('save_admin_snapshot', {
      p_snapshot: state.snapshot,
      p_expected_revision: state.revision,
    })
    if (!error) return true
    if (error.code !== '40001' && error.message !== 'STALE_SNAPSHOT') {
      throw new Error(`FINALIZE_DRIVE_IMPORT: ${error.message}`)
    }
  }

  const finalState = await readAdminSnapshot(serviceClient, organizationId)
  const finalSource = finalState.snapshot.video_sources.find((item) => item.video_id === videoId)
  if (
    finalSource?.provider === 'supabase_storage'
    && finalSource.storage_bucket === STORAGE_BUCKET
    && finalSource.storage_object_path === storageObjectPath
  ) return true
  if (finalSource?.provider !== 'google_drive' || finalSource.source_ref !== expectedSourceRef) {
    return false
  }

  throw new Error('FINALIZE_RETRY_EXHAUSTED')
}

async function shouldKeepUploadedObject({
  serviceClient,
  videoId,
  expectedSourceRef,
  storageObjectPath,
}) {
  const { data, error } = await serviceClient
    .from('video_sources')
    .select('provider,source_ref,storage_bucket,storage_object_path')
    .eq('video_id', videoId)
    .maybeSingle()
  if (error) return true

  const awaitingRetry = data?.provider === 'google_drive' && data.source_ref === expectedSourceRef
  const alreadyReferenced = data?.provider === 'supabase_storage'
    && data.storage_bucket === STORAGE_BUCKET
    && data.storage_object_path === storageObjectPath
  return awaitingRetry || alreadyReferenced
}

async function importDriveVideo({
  serviceClient,
  userClient,
  organizationId,
  videoId,
  source,
}) {
  const response = await fetchDriveResponse(source.source_ref, source.source_url)
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const extension = getVideoExtension(contentType)
  if (!extension) {
    await response.body?.cancel()
    throw new Error('DRIVE_UNSUPPORTED_VIDEO_TYPE')
  }

  const bytes = await readResponseWithinLimit(response, getMaximumImportBytes())
  const storageObjectPath = getStorageObjectPath(videoId, source.source_ref, extension)
  const { error: uploadError } = await serviceClient.storage
    .from(STORAGE_BUCKET)
    .upload(storageObjectPath, bytes, {
      cacheControl: '3600',
      contentType,
      upsert: true,
    })
  if (uploadError) throw new Error(`UPLOAD_DRIVE_VIDEO: ${uploadError.message}`)

  let finalized = false
  try {
    finalized = await finalizeImportedSource({
      serviceClient,
      userClient,
      organizationId,
      videoId,
      expectedSourceRef: source.source_ref,
      storageObjectPath,
      contentType,
      byteLength: bytes.byteLength,
    })
    return finalized
  } finally {
    const keepObject = !finalized && await shouldKeepUploadedObject({
      serviceClient,
      videoId,
      expectedSourceRef: source.source_ref,
      storageObjectPath,
    })
    if (!finalized && !keepObject) {
      await serviceClient.storage.from(STORAGE_BUCKET).remove([storageObjectPath])
    }
  }
}

export default async function importDriveVideos(request) {
  if (request.method !== 'POST') return

  try {
    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return

    const accessToken = readBearerToken(request)
    if (!accessToken) return

    const body = await readJsonBody(request)
    const videoIds = normalizeVideoIds(body?.videoIds)
    if (!videoIds.length) return

    const configuration = getServerConfiguration()
    const { publicClient, serviceClient } = createServerClients(configuration)
    const { data: callerData, error: callerError } = await publicClient.auth.getUser(accessToken)
    const caller = callerData?.user
    if (callerError || !caller) return

    const accessContext = await getAccessContext(accessToken, configuration)
    if (
      !accessContext
      || accessContext.active !== true
      || accessContext.userId !== caller.id
      || accessContext.role !== 'admin'
    ) return

    const videosResult = await serviceClient
      .from('videos')
      .select('id')
      .eq('organization_id', accessContext.organizationId)
      .eq('active', true)
      .in('id', videoIds)
    const videos = requireResult(videosResult, 'READ_IMPORT_VIDEOS') || []
    const allowedVideoIds = new Set(videos.map((video) => video.id))
    if (!allowedVideoIds.size) return

    const sourcesResult = await serviceClient
      .from('video_sources')
      .select('video_id,provider,source_ref,source_url,thumbnail_url,metadata')
      .eq('provider', 'google_drive')
      .in('video_id', [...allowedVideoIds])
    const sources = requireResult(sourcesResult, 'READ_IMPORT_SOURCES') || []
    const userClient = createUserClient(accessToken, configuration)

    const failures = []
    for (const source of sources) {
      try {
        await importDriveVideo({
          serviceClient,
          userClient,
          organizationId: accessContext.organizationId,
          videoId: source.video_id,
          source,
        })
      } catch (error) {
        failures.push(error)
        console.error('Drive video import failed', {
          videoId: source.video_id,
          reason: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
        })
      }
    }
    if (failures.length) throw new Error('DRIVE_IMPORT_INCOMPLETE')
  } catch (error) {
    console.error('Drive video import request failed', {
      reason: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    })
    throw error
  }
}
