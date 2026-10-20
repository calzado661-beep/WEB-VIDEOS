import { mkdir, readFile, writeFile } from 'node:fs/promises'

const directory = new URL('../supabase/migrations/', import.meta.url)
const documents = await readFile(new URL('20261020140818_document_multiple_audiences.sql', directory), 'utf8')
const value = await readFile(new URL('20261020161159_content_administrator_role_value.sql', directory), 'utf8')
const permissions = await readFile(new URL('20261020161224_content_administrator_permissions.sql', directory), 'utf8')
const uploadRepair = await readFile(new URL('20261020162833_repair_document_upload_policy.sql', directory), 'utf8')
const output = new URL('../outputs/activate-content-administrator.sql', import.meta.url)
await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, `-- Run after the operational role migrations in the portal's Supabase SQL Editor.
-- Existing site managers keep role 'admin'. The new 'administrator' role only
-- receives explicitly assigned content. Preserve the separate transactions.
${documents}

begin;
${value}
commit;

${permissions}

${uploadRepair}`, 'utf8')
console.log('SQL preparado: outputs/activate-content-administrator.sql')
