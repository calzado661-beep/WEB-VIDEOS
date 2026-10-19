import { loadEnv } from 'vite'
import { USER_ROLES } from '../src/data.js'

const env = loadEnv('development', process.cwd(), '')
const projectUrl = env.VITE_SUPABASE_URL?.replace(/\/$/, '')
const secretKey = env.SUPABASE_SECRET_KEY

if (!projectUrl || !secretKey) {
  console.error('Faltan VITE_SUPABASE_URL o SUPABASE_SECRET_KEY en .env')
  process.exit(1)
}

const resources = [
  ['organizations', 'id,name,slug'],
  ['app_settings', 'organization_id,product_name'],
  ['profiles', 'user_id,organization_id,role'],
  ['sections', 'id,organization_id,name'],
  ['section_roles', 'section_id,role,visible'],
  ['section_content_settings', 'section_id,organization_id,content_type'],
  ['section_documents', 'id,organization_id,section_id,storage_object_path'],
  ['videos', 'id,organization_id,title'],
  ['video_sources', 'video_id,provider'],
  ['video_assignments', 'video_id,role,is_locked,prerequisite_video_id'],
  ['video_quizzes', 'video_id,max_attempts'],
  ['video_quiz_results', 'video_id,user_id,attempts_count,extra_attempts'],
  ['video_quiz_attempts', 'video_id,user_id,request_id'],
  ['audit_events', 'id,organization_id,action'],
]

let failed = false
let migrationsPending = false

for (const [table, select] of resources) {
  try {
    const response = await fetch(
      `${projectUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=1`,
      {
        headers: {
          apikey: secretKey,
        },
        signal: AbortSignal.timeout(15_000),
      },
    )

    const ok = response.status >= 200 && response.status < 300
    console.log(`${ok ? 'OK' : 'ERROR'} · public.${table} · HTTP ${response.status}`)
    if (!ok) failed = true
  } catch (error) {
    console.log(`ERROR · public.${table} · ${error.name}`)
    failed = true
  }
}

for (const bucket of ['video-assets', 'document-assets']) {
try {
  const response = await fetch(`${projectUrl}/storage/v1/bucket/${bucket}`, {
    headers: {
      apikey: secretKey,
    },
    signal: AbortSignal.timeout(15_000),
  })
  const ok = response.status >= 200 && response.status < 300
  console.log(`${ok ? 'OK' : 'ERROR'} · storage.${bucket} · HTTP ${response.status}`)
  if (!ok) failed = true
} catch (error) {
  console.log(`ERROR · storage.${bucket} · ${error.name}`)
  failed = true
}
}

const requiredRpcChecks = [
  ['service_rotate_access_codes', {
    p_organization_id: null,
    p_admin_auth_user_id: null,
    p_admin_code_fingerprint: null,
    p_operator_auth_user_id: null,
    p_operator_code_fingerprint: null,
    p_boss_auth_user_id: null,
    p_boss_code_fingerprint: null,
  }],
  ['save_admin_snapshot', {
    p_snapshot: {},
    p_expected_revision: 0,
  }],
]

// A table can exist while its enum is still missing values expected by the app.
// Read-only probes also work when no users have been assigned the new roles yet.
for (const role of ['salesperson', 'management']) {
  try {
    const response = await fetch(`${projectUrl}/rest/v1/profiles?select=user_id&role=eq.${role}&limit=0`, {
      headers: { apikey: secretKey },
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => ({}))
    if (payload?.code === '22P02') {
      console.log(`PENDIENTE · Rol ${role} · Completa las migraciones de roles.`)
      migrationsPending = true
    } else if (!response.ok) {
      console.log(`ERROR · Rol ${role} · HTTP ${response.status}`)
      failed = true
    } else {
      console.log(`OK · Rol ${role}`)
    }
  } catch (error) {
    console.log(`ERROR · Rol ${role} · ${error.name}`)
    failed = true
  }
}

try {
  const response = await fetch(`${projectUrl}/rest/v1/rpc/get_role_configuration`, {
    method: 'POST', headers: { apikey: secretKey, 'content-type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(15_000),
  })
  const configuration = await response.json().catch(() => ({}))
  if (configuration?.code === 'PGRST202' || (response.ok && (configuration?.version !== 3 || !USER_ROLES.every((role) => configuration?.userRoles?.includes(role))))) {
    console.log('PENDIENTE · Configuración completa de los cinco roles · Aplica operational_roles_consistency.')
    migrationsPending = true
  } else if (!response.ok) {
    console.log(`ERROR · Configuración de roles · HTTP ${response.status}`)
    failed = true
  } else {
    console.log('OK · Configuración completa de los cinco roles')
  }
} catch (error) {
  console.log(`ERROR · Configuración de roles · ${error.name}`)
  failed = true
}

for (const [rpc, body] of requiredRpcChecks) {
  try {
    const response = await fetch(`${projectUrl}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: {
        apikey: secretKey,
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => ({}))
    const missing = payload?.code === 'PGRST202'
      || /could not find the function|does not exist/i.test(payload?.message || '')
    console.log(`${missing ? 'PENDIENTE' : 'OK'} · RPC public.${rpc}`)
    if (missing) migrationsPending = true
  } catch (error) {
    console.log(`ERROR · RPC public.${rpc} · ${error.name}`)
    failed = true
  }
}

if (migrationsPending) {
  console.log('PENDIENTE · Aplica las migraciones pendientes de supabase/migrations antes de desplegar.')
}

if (failed || migrationsPending) process.exit(1)
