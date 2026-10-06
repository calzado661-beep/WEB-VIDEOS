import { jsonResponse, methodNotAllowed, readBearerToken, readJsonBody } from './_shared/http.js'
import {
  createServerClients,
  getAccessContext,
  getServerConfiguration,
  ServerConfigurationError,
} from './_shared/supabase-server.js'

const MANAGED_ROLES = ['operator', 'boss']
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_DISPLAY_NAME_LENGTH = 80
const MAX_JOB_TITLE_LENGTH = 120
const MAX_DEPARTMENT_LENGTH = 120
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default async function updateUser(request) {
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
      return jsonResponse({ error: 'Solo un administrador puede editar usuarios.' }, 403)
    }

    const userId = String(body.userId || '')
    if (!UUID_PATTERN.test(userId)) {
      return jsonResponse({ error: 'Usuario no válido.' }, 400)
    }
    if (userId === caller.id) {
      return jsonResponse({ error: 'No puedes editar tu propia cuenta desde aquí.' }, 403)
    }

    const { data: targetProfile, error: targetProfileError } = await serviceClient
      .from('profiles')
      .select('user_id, organization_id, role, username')
      .eq('user_id', userId)
      .eq('organization_id', accessContext.organizationId)
      .maybeSingle()

    if (targetProfileError) {
      return jsonResponse({ error: 'No se pudo cargar el usuario.' }, 503)
    }
    if (!targetProfile || !MANAGED_ROLES.includes(targetProfile.role)) {
      return jsonResponse({ error: 'Ese usuario no existe.' }, 404)
    }

    const updates = {}

    if (body.displayName !== undefined) {
      const displayName = String(body.displayName || '').trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
      if (!displayName) {
        return jsonResponse({ error: 'Escribe un nombre para el usuario.' }, 400)
      }
      updates.display_name = displayName
    }

    if (body.role !== undefined) {
      if (!MANAGED_ROLES.includes(body.role)) {
        return jsonResponse({ error: 'El rol debe ser operante o jefe.' }, 400)
      }
      updates.role = body.role
    }

    if (body.jobTitle !== undefined) {
      const jobTitle = String(body.jobTitle || '').trim().slice(0, MAX_JOB_TITLE_LENGTH)
      if (!jobTitle) {
        return jsonResponse({ error: 'Escribe el cargo del usuario.' }, 400)
      }
      updates.job_title = jobTitle
    }

    if (body.department !== undefined) {
      const department = String(body.department || '').trim().slice(0, MAX_DEPARTMENT_LENGTH)
      if (!department) {
        return jsonResponse({ error: 'Escribe el área del usuario.' }, 400)
      }
      updates.department = department
    }

    if (body.active !== undefined) {
      updates.active = Boolean(body.active)
    }

    if (body.requireQuizPhotoOverride !== undefined) {
      if (targetProfile.username !== 'invitado.nissei') {
        return jsonResponse({ error: 'Esta opción es exclusiva del usuario invitado.' }, 400)
      }
      if (body.requireQuizPhotoOverride !== null && typeof body.requireQuizPhotoOverride !== 'boolean') {
        return jsonResponse({ error: 'La opción de foto no es válida.' }, 400)
      }
      updates.require_quiz_photo_override = body.requireQuizPhotoOverride
    }

    if (body.newPassword !== undefined) {
      const newPassword = String(body.newPassword || '')
      if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
        return jsonResponse({ error: `La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres.` }, 400)
      }
      const { error: passwordError } = await serviceClient.auth.admin.updateUserById(userId, {
        password: newPassword,
      })
      if (passwordError) {
        return jsonResponse({ error: 'No se pudo actualizar la contraseña.' }, 503)
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await serviceClient
        .from('profiles')
        .update(updates)
        .eq('user_id', userId)
        .eq('organization_id', accessContext.organizationId)

      if (updateError) {
        return jsonResponse({ error: 'No se pudo actualizar el usuario.' }, 503)
      }
    }

    return jsonResponse({ ok: true })
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
