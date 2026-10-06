import { loadEnv } from 'vite'

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
  console.log('PENDIENTE · Aplica las migraciones 20260804010000 y 20260804020000 para activar todo el hardening.')
}

if (failed) process.exit(1)
