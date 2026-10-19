import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

const organizationId = '10000000-0000-4000-8000-000000000001'
const currentUserId = '10000000-0000-4000-8000-000000000002'

test('la lista de usuarios funciona antes y después de instalar los nuevos roles', async (t) => {
  // Load the actual browser API with isolated configuration; never use .env.
  const server = await createServer({
    configFile: false,
    envDir: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://compatibility-test.supabase.co'),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('test-public-key'),
    },
  })
  t.after(() => server.close())
  const { listManagedUsers } = await server.ssrLoadModule('/src/lib/videoHubApi.js')
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  for (const installedRoles of [['admin', 'operator', 'boss'], ['admin', 'operator', 'boss', 'salesperson', 'management']]) {
    const requests = []
    globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.pathname.endsWith('/rpc/get_my_access_context')) {
        return respond({ userId: currentUserId, organizationId, role: 'admin', active: true })
      }
      assert.equal(url.pathname, '/rest/v1/profiles')
      assert.equal(url.searchParams.get('organization_id'), `eq.${organizationId}`)
      requests.push(url)
      const roleFilter = url.searchParams.get('role') || ''
      for (const role of ['salesperson', 'management']) {
        if (!installedRoles.includes(role) && roleFilter.includes(role)) {
          return respond({ code: '22P02', message: `invalid input value for enum app_role: "${role}"` }, 400)
        }
      }
      const roles = roleFilter === 'neq.admin' ? installedRoles.filter((role) => role !== 'admin') : installedRoles
      return respond(roles.map((role, index) => ({
        user_id: role === 'admin' ? currentUserId : `user-${index}`, username: role,
        role, organization_id: organizationId, active: true, job_title: 'Cargo', department: 'Área',
      })))
    }
    const allUsers = await listManagedUsers({ includeAdmins: true })
    assert.deepEqual(allUsers.map((user) => user.role), installedRoles)
    assert.equal(allUsers[0].isCurrentUser, true)
    const viewers = await listManagedUsers()
    assert.deepEqual(viewers.map((user) => user.role), installedRoles.filter((role) => role !== 'admin'))
    assert.equal(requests[0].searchParams.has('role'), false)
    assert.equal(requests[1].searchParams.get('role'), 'neq.admin')
  }
})
