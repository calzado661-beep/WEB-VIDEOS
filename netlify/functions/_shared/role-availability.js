import { getRoleSchemaIssue } from '../../../src/roleErrors.js'

export async function getRoleAvailabilityError(client, organizationId, role) {
  // A read-only enum check prevents creating Auth accounts or changing passwords
  // when the requested role has not been installed in this database yet.
  const { error } = await client.from('profiles').select('user_id')
    .eq('organization_id', organizationId).eq('role', role).limit(0)
  if (!error) return null
  const issue = getRoleSchemaIssue(error)
  return issue
    ? { body: issue, status: 409 }
    : { body: { error: 'No se pudo comprobar la disponibilidad del rol.' }, status: 503 }
}
