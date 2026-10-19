export function getRoleSchemaIssue(error) {
  const message = String(error?.message || '')
  if ((error?.code === '22P02' && /app_role/i.test(message))
    || (error?.code === '23514' && /section_documents_audience_check|section_roles_role_check|video_assignments_role_check/i.test(message))) {
    return {
      code: 'ROLE_SCHEMA_PENDING',
      error: 'La configuración de roles todavía no está activada por completo. Un administrador debe completar la actualización antes de usar esta opción.',
    }
  }
  return null
}
