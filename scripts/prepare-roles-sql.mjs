import { mkdir, readFile, writeFile } from 'node:fs/promises'

const migrations = new URL('../supabase/migrations/', import.meta.url)
const values = await readFile(new URL('20261019202553_operational_role_values.sql', migrations), 'utf8')
const permissions = await readFile(new URL('20261019202600_operational_role_permissions.sql', migrations), 'utf8')
const output = new URL('../outputs/activate-operational-roles.sql', import.meta.url)

await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, `-- Run in the SQL Editor of the portal's Supabase project.
-- Keep these two transactions separate: PostgreSQL must commit new enum values
-- before using them. Existing users and content permissions are preserved.
begin;
${values}
commit;

${permissions}`, 'utf8')
console.log('SQL preparado: outputs/activate-operational-roles.sql')
