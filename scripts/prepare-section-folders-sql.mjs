import './prepare-content-administrator-sql.mjs'
import { readFile, writeFile } from 'node:fs/promises'

const roles = await readFile(new URL('../outputs/activate-content-administrator.sql', import.meta.url), 'utf8')
const folders = await readFile(new URL('../supabase/migrations/20261020203001_section_subfolders.sql', import.meta.url), 'utf8')
await writeFile(new URL('../outputs/activate-section-folders.sql', import.meta.url), `-- Activate folders after the existing operational role migrations.
-- Preserves users and files. Includes the preceding content-role and upload fixes.
${roles}

${folders}`, 'utf8')
console.log('SQL preparado: outputs/activate-section-folders.sql')
