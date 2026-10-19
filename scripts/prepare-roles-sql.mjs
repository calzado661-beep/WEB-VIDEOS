import { mkdir, readFile, writeFile } from 'node:fs/promises'

const migrations = new URL('../supabase/migrations/', import.meta.url)
const values = await readFile(new URL('20261019202553_operational_role_values.sql', migrations), 'utf8')
const consistency = await readFile(new URL('20261019222833_operational_roles_consistency.sql', migrations), 'utf8')
const output = new URL('../outputs/activate-operational-roles.sql', import.meta.url)

await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, `-- Run in the SQL Editor of the portal's Supabase project.
-- Keep these transactions separate: PostgreSQL must commit new enum values
-- before using them. Existing users and content permissions are preserved.
-- The final permissions definition supersedes the intermediate four-role
-- migration, so this manual upgrade is also safe to run again after activation.
begin;
${values}
commit;

${consistency}`, 'utf8')
console.log('SQL preparado: outputs/activate-operational-roles.sql')
