import assert from 'node:assert/strict'
import test from 'node:test'
import createUser from '../netlify/functions/create-user.js'
import updateUser from '../netlify/functions/update-user.js'
import { USER_ROLES } from '../src/data.js'

const callerId = '10000000-0000-4000-8000-000000000001'
const targetId = '10000000-0000-4000-8000-000000000002'
const organizationId = '10000000-0000-4000-8000-000000000003'

function mockSupabase(t, { callerRole = 'admin', active = true, targetInOrganization = true, installedRoles = USER_ROLES } = {}) {
  const originalFetch = globalThis.fetch
  const configuration = {
    SUPABASE_URL: 'https://roles-test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test-public-key',
    SUPABASE_SECRET_KEY: 'test-secret-key',
  }
  const previous = Object.fromEntries(Object.keys(configuration).map((key) => [key, process.env[key]]))
  Object.assign(process.env, configuration)
  const writes = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const method = options.method || 'GET'
    const respond = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/auth/v1/user') return respond({ id: callerId })
    if (url.pathname === '/rest/v1/rpc/get_my_access_context') {
      return respond({ userId: callerId, organizationId, role: callerRole, active })
    }
    if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      writes.push({ path: url.pathname, ...JSON.parse(options.body) })
      return respond({ id: targetId })
    }
    if (url.pathname === '/rest/v1/profiles') {
      if (method === 'GET' && url.searchParams.has('role')) {
        assert.equal(url.searchParams.get('organization_id'), `eq.${organizationId}`)
        const role = url.searchParams.get('role').replace(/^eq\./, '')
        return installedRoles.includes(role) ? respond([])
          : new Response(JSON.stringify({ code: '22P02', message: `invalid input value for enum app_role: "${role}"` }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'GET' && url.searchParams.has('username')) return respond([])
      if (method === 'GET') {
        assert.equal(url.searchParams.get('organization_id'), `eq.${organizationId}`)
        return respond(targetInOrganization ? [{ user_id: targetId, organization_id: organizationId, role: 'boss', username: 'tester' }] : [])
      }
      writes.push({ path: url.pathname, ...JSON.parse(options.body) })
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return writes
}

function request(body) {
  return new Request('https://portal.test/.netlify/functions/users', {
    method: 'POST',
    headers: { authorization: 'Bearer test-session', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const userDraft = { username: 'tester', password: 'test-password', displayName: 'Test', jobTitle: 'Cargo', department: 'Área' }

test('un administrador puede crear y asignar cualquiera de los cinco roles', async (t) => {
  const writes = mockSupabase(t)
  for (const role of USER_ROLES) {
    const created = await createUser(request({ ...userDraft, role }))
    assert.equal(created.status, 200, await created.text())
    assert.equal(writes.at(-1).role, role)
    const updated = await updateUser(request({ userId: targetId, role }))
    assert.equal(updated.status, 200, await updated.text())
    assert.equal(writes.at(-1).role, role)
  }
})

test('rechaza roles fuera del catálogo antes de modificar Auth o perfiles', async (t) => {
  const writes = mockSupabase(t)
  for (const role of ['warehouse_assistant', 'home', '', 'superadmin']) {
    assert.equal((await createUser(request({ ...userDraft, role }))).status, 400)
    assert.equal((await updateUser(request({ userId: targetId, role }))).status, 400)
  }
  assert.equal(writes.length, 0)
})

test('los roles de contenido no pueden crear usuarios ni elevar permisos', async (t) => {
  const writes = mockSupabase(t, { callerRole: 'management' })
  assert.equal((await createUser(request({ ...userDraft, role: 'admin' }))).status, 403)
  assert.equal((await updateUser(request({ userId: targetId, role: 'admin' }))).status, 403)
  assert.equal(writes.length, 0)
})

test('un administrador no puede editar su propia cuenta ni cuentas de otra organización', async (t) => {
  const writes = mockSupabase(t, { targetInOrganization: false })
  assert.equal((await updateUser(request({ userId: callerId, active: false }))).status, 403)
  assert.equal((await updateUser(request({ userId: targetId, role: 'admin' }))).status, 404)
  assert.equal(writes.length, 0)
})

test('una cuenta deshabilitada no administra usuarios aunque tenga rol admin', async (t) => {
  const writes = mockSupabase(t, { active: false })
  assert.equal((await createUser(request({ ...userDraft, role: 'salesperson' }))).status, 403)
  assert.equal((await updateUser(request({ userId: targetId, role: 'management' }))).status, 403)
  assert.equal(writes.length, 0)
})

test('una migración pendiente no crea cuentas ni cambia contraseñas parcialmente', async (t) => {
  const writes = mockSupabase(t, { installedRoles: ['admin', 'operator', 'boss'] })
  for (const role of ['salesperson', 'management']) {
    const created = await createUser(request({ ...userDraft, role }))
    assert.equal(created.status, 409)
    assert.equal((await created.json()).code, 'ROLE_SCHEMA_PENDING')
    const updated = await updateUser(request({ userId: targetId, role, newPassword: 'new-password' }))
    assert.equal(updated.status, 409)
    assert.equal((await updated.json()).code, 'ROLE_SCHEMA_PENDING')
  }
  assert.equal(writes.length, 0)
})
