import { jsonResponse, methodNotAllowed, readJsonBody } from './_shared/http.js'
import {
  createFingerprint,
  createServerClients,
  getAccessContext,
  getClientIp,
  getServerConfiguration,
  ServerConfigurationError,
} from './_shared/supabase-server.js'

const INVALID_CREDENTIALS_MESSAGE = 'Usuario o contraseña no válidos.'
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60
const MAX_USER_FAILURES = 8
const MAX_IP_FAILURES = 30
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/
// Supabase Auth permits the existing six-character Nissei passwords.
const MIN_PASSWORD_LENGTH = 6
const MAX_PASSWORD_LENGTH = 128

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isValidPassword(value) {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH
}

async function recordAttempt(serviceClient, { organizationId = null, userFingerprint, ipFingerprint, succeeded }) {
  return serviceClient.rpc('service_record_access_attempt', {
    p_organization_id: organizationId,
    p_code_fingerprint: userFingerprint,
    p_ip_fingerprint: ipFingerprint,
    p_succeeded: succeeded,
  })
}

async function rejectInvalidCredentials(serviceClient, attempt) {
  const { error } = await recordAttempt(serviceClient, { ...attempt, succeeded: false })

  if (error) {
    return jsonResponse({ error: 'No se pudo validar el acceso.' }, 503)
  }

  return jsonResponse({ error: INVALID_CREDENTIALS_MESSAGE }, 401)
}

export default async function loginWithPassword(request, context) {
  if (request.method !== 'POST') {
    return methodNotAllowed()
  }

  try {
    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
      return jsonResponse({ error: 'Origen no permitido.' }, 403)
    }

    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Solicitud no válida.' }, 400)
    }

    const username = normalizeUsername(body?.username)
    const password = typeof body?.password === 'string' ? body.password : ''
    const configuration = getServerConfiguration()
    const { publicClient, serviceClient } = createServerClients(configuration)
    const userFingerprint = createFingerprint(`user:${username}`, configuration.accessCodePepper)
    const ipFingerprint = createFingerprint(
      `ip:${getClientIp(request, context)}`,
      configuration.accessCodePepper,
    )

    const [userFailuresResult, ipFailuresResult] = await Promise.all([
      serviceClient.rpc('service_count_recent_failures', {
        p_code_fingerprint: userFingerprint,
        p_ip_fingerprint: null,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      }),
      serviceClient.rpc('service_count_recent_failures', {
        p_code_fingerprint: null,
        p_ip_fingerprint: ipFingerprint,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      }),
    ])

    if (userFailuresResult.error || ipFailuresResult.error) {
      return jsonResponse({ error: 'No se pudo validar el acceso.' }, 503)
    }

    if (
      Number(userFailuresResult.data || 0) >= MAX_USER_FAILURES
      || Number(ipFailuresResult.data || 0) >= MAX_IP_FAILURES
    ) {
      return jsonResponse(
        { error: 'Demasiados intentos. Inténtalo nuevamente más tarde.', retry_after: RATE_LIMIT_WINDOW_SECONDS },
        429,
        { 'retry-after': String(RATE_LIMIT_WINDOW_SECONDS) },
      )
    }

    const baseAttempt = { userFingerprint, ipFingerprint }

    if (!USERNAME_PATTERN.test(username) || !isValidPassword(password)) {
      return rejectInvalidCredentials(serviceClient, baseAttempt)
    }

    const { data: profile, error: profileError } = await serviceClient
      .from('profiles')
      .select('user_id, organization_id, role, active')
      .eq('username', username)
      .maybeSingle()

    if (profileError) {
      return jsonResponse({ error: 'No se pudo validar el acceso.' }, 503)
    }

    if (!profile?.user_id || !profile.active) {
      return rejectInvalidCredentials(serviceClient, baseAttempt)
    }

    const { data: authUserData, error: authUserError } = await serviceClient.auth.admin.getUserById(
      profile.user_id,
    )
    const email = authUserData?.user?.email

    if (authUserError || !email) {
      return rejectInvalidCredentials(serviceClient, { ...baseAttempt, organizationId: profile.organization_id })
    }

    const { data: authData, error: signInError } = await publicClient.auth.signInWithPassword({
      email,
      password,
    })
    const session = authData?.session

    if (signInError || !session?.access_token || !session?.refresh_token || !authData?.user) {
      return rejectInvalidCredentials(serviceClient, { ...baseAttempt, organizationId: profile.organization_id })
    }

    const accessContext = await getAccessContext(session.access_token, configuration)
    const contextMatchesLookup = (
      accessContext?.active === true
      && accessContext.userId === authData.user.id
      && accessContext.userId === profile.user_id
      && accessContext.organizationId === profile.organization_id
      && accessContext.role === profile.role
    )

    if (!contextMatchesLookup) {
      await serviceClient.auth.admin.signOut(session.access_token, 'local')
      return rejectInvalidCredentials(serviceClient, { ...baseAttempt, organizationId: profile.organization_id })
    }

    const { error: recordError } = await recordAttempt(serviceClient, {
      ...baseAttempt,
      organizationId: profile.organization_id,
      succeeded: true,
    })

    if (recordError) {
      await serviceClient.auth.admin.signOut(session.access_token, 'local')
      return jsonResponse({ error: 'No se pudo completar el acceso.' }, 503)
    }

    return jsonResponse({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at ?? null,
      expires_in: session.expires_in ?? null,
      token_type: session.token_type || 'bearer',
      role: accessContext.role,
      user_id: accessContext.userId,
      organization_id: accessContext.organizationId,
      organization: accessContext.organization,
      display_name: accessContext.displayName || null,
    })
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return jsonResponse({
        error: 'Falta configurar Supabase en Netlify.',
        code: error.code,
        missing_variables: error.missingVariables,
      }, 503)
    }
    return jsonResponse({ error: 'El servicio de acceso no está disponible.' }, 500)
  }
}
