import { jsonResponse, methodNotAllowed, readBearerToken, readJsonBody } from './_shared/http.js'
import {
  createServerClients,
  getAccessContext,
  getServerConfiguration,
  ServerConfigurationError,
} from './_shared/supabase-server.js'

import { USER_ROLES as MANAGED_ROLES } from '../../src/data.js'
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_DISPLAY_NAME_LENGTH = 80
const MAX_JOB_TITLE_LENGTH = 120
const MAX_DEPARTMENT_LENGTH = 120

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export default async function createUser(request) {
  if (request.method !== 'POST') {
    return methodNotAllowed()
  }

  try {
    const accessToken = readBearerToken(request)
    if (!accessToken) {
      return jsonResponse({ error: 'Sesión no válida.' }, 401)
    }

    const body = await readJsonBody(request)
    if (!body) {
      return jsonResponse({ error: 'Solicitud no válida.' }, 400)
    }

    const configuration = getServerConfiguration()
    const { publicClient, serviceClient } = createServerClients(configuration)
    const { data: callerData, error: callerError } = await publicClient.auth.getUser(accessToken)
    const caller = callerData?.user

    if (callerError || !caller) {
      return jsonResponse({ error: 'Sesión no válida.' }, 401)
    }

    const accessContext = await getAccessContext(accessToken, configuration)

    if (
      !accessContext
      || accessContext.active !== true
      || accessContext.userId !== caller.id
      || accessContext.role !== 'admin'
    ) {
      return jsonResponse({ error: 'Solo un administrador puede crear usuarios.' }, 403)
    }

    const username = normalizeUsername(body.username)
    const password = typeof body.password === 'string' ? body.password : ''
    const role = typeof body.role === 'string' ? body.role : ''
    const displayName = String(body.displayName || '').trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
    const jobTitle = String(body.jobTitle || '').trim().slice(0, MAX_JOB_TITLE_LENGTH)
    const department = String(body.department || '').trim().slice(0, MAX_DEPARTMENT_LENGTH)

    if (!USERNAME_PATTERN.test(username)) {
      return jsonResponse({ error: 'El usuario debe tener entre 3 y 32 caracteres (minúsculas, números, puntos, guiones).' }, 400)
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return jsonResponse({ error: `La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres.` }, 400)
    }
    if (!MANAGED_ROLES.includes(role)) {
      return jsonResponse({ error: 'Selecciona un rol de usuario válido.' }, 400)
    }
    if (!displayName) {
      return jsonResponse({ error: 'Escribe un nombre para el usuario.' }, 400)
    }
    if (!jobTitle) {
      return jsonResponse({ error: 'Escribe el cargo del usuario.' }, 400)
    }
    if (!department) {
      return jsonResponse({ error: 'Escribe el área del usuario.' }, 400)
    }

    const { data: existingProfile, error: existingProfileError } = await serviceClient
      .from('profiles')
      .select('user_id')
      .eq('username', username)
      .maybeSingle()

    if (existingProfileError) {
      return jsonResponse({ error: 'No se pudo comprobar el usuario.' }, 503)
    }
    if (existingProfile) {
      return jsonResponse({ error: 'Ese usuario ya existe.' }, 409)
    }

    const { data: createdUser, error: createUserError } = await serviceClient.auth.admin.createUser({
      email: `${username}@accounts.invalid`,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName, managed_by: 'admin-ui' },
      app_metadata: {
        video_hub_organization_id: accessContext.organizationId,
        video_hub_role: role,
      },
    })

    if (createUserError || !createdUser?.user) {
      return jsonResponse({ error: 'No se pudo crear la cuenta de acceso.' }, 503)
    }

    const { error: insertProfileError } = await serviceClient.from('profiles').insert({
      user_id: createdUser.user.id,
      organization_id: accessContext.organizationId,
      role,
      display_name: displayName,
      username,
      job_title: jobTitle,
      department,
      active: true,
    })

    if (insertProfileError) {
      await serviceClient.auth.admin.deleteUser(createdUser.user.id)
      const status = insertProfileError.code === '23505' ? 409 : 503
      return jsonResponse({
        error: status === 409 ? 'Ese usuario ya existe.' : 'No se pudo crear el perfil del usuario.',
      }, status)
    }

    return jsonResponse({ ok: true, user_id: createdUser.user.id })
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return jsonResponse({
        error: 'Falta configurar Supabase en Netlify.',
        code: error.code,
        missing_variables: error.missingVariables,
      }, 503)
    }
    return jsonResponse({ error: 'El servicio de usuarios no está disponible.' }, 500)
  }
}
