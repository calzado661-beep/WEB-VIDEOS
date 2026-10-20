import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { ROLE_META, USER_ROLES, VIEWER_ROLES } from '../src/data.js'

test('las pantallas y sus selectores contemplan los cinco roles', async (t) => {
  const names = ['AdminOverview', 'SectionsManager', 'VideosManager', 'UsersManager', 'ProgressManager', 'RolePreview']
  const server = await createServer({
    configFile: false, envDir: false,
    cacheDir: 'node_modules/.vite-role-ui-test',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    plugins: [react(), {
      name: 'expose-components-for-render-test', enforce: 'pre',
      transform(code, id) {
        if (id.replace(/\\/g, '/').endsWith('/src/App.jsx')) return `${code}\nexport { ${names.join(', ')} };`
      },
    }],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://ui-test.supabase.co'),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('test-key'),
    },
  })
  t.after(() => server.close())
  const components = { ...await server.ssrLoadModule('/src/App.jsx') }
  components.DocumentsManager = (await server.ssrLoadModule('/src/DocumentsManager.jsx')).default
  components.QuizAttemptsManager = (await server.ssrLoadModule('/src/QuizAttemptsManager.jsx')).default
  const data = {
    organization: 'Demo', organizationId: 'demo', settings: {},
    sections: [{ id: 's', name: 'Sección', roles: VIEWER_ROLES, order: 0, icon: 'layers' }],
    videos: [{ id: 'v', title: 'Video de prueba', description: 'Descripción', url: 'https://example.test/video.mp4', assignments: Object.fromEntries(VIEWER_ROLES.map((role) => [role, 's'])), locked: {}, quiz: null }],
    documents: [],
  }
  for (const name of [...names, 'DocumentsManager', 'QuizAttemptsManager']) {
    const html = renderToStaticMarkup(createElement(components[name], { data, setData() {}, saveState: { status: 'saved' }, persistedVideoIdsRef: { current: new Set(['v']) } }))
    for (const role of name === 'SectionsManager' ? VIEWER_ROLES : USER_ROLES) assert.ok(html.includes(ROLE_META[role].label), `${name} debe mostrar ${role}`)
    if (name !== 'AdminOverview' && name !== 'SectionsManager') {
      for (const role of name === 'DocumentsManager' ? VIEWER_ROLES : USER_ROLES) assert.ok(html.includes(`<option value="${role}"`), `${name} debe incluir la opción ${role}`)
    }
    if (name === 'SectionsManager') {
      assert.ok(!html.includes(ROLE_META.admin.label))
      assert.match(html, /<button[^>]*aria-pressed="true"[^>]*><span>.*?<\/span>Administradores<\/button>/)
      assert.doesNotMatch(html, /disabled=""[^>]*title="Acceso total automático"/)
    }
  }
  const { prepareSnapshot } = await server.ssrLoadModule('/src/lib/videoHubApi.js')
  const sectionId = '20000000-0000-4000-8000-000000000001'
  const snapshot = {
    sections: [{ id: sectionId, name: 'Ventas', roles: ['salesperson', 'management'] }],
    videos: [{ id: '30000000-0000-4000-8000-000000000001', title: 'Video', description: 'Curso', url: 'https://example.test/video.mp4', assignments: { admin: sectionId, salesperson: sectionId, operator: sectionId }, locked: { admin: true, salesperson: true }, prerequisites: { admin: 'ignored-admin-prerequisite' } }],
  }
  const prepared = prepareSnapshot(snapshot, '10000000-0000-4000-8000-000000000001', [])
  assert.deepEqual(prepared.sectionRoleRows.map((row) => row.role), USER_ROLES)
  assert.equal(prepared.sectionRoleRows.find((row) => row.role === 'admin').visible, true)
  assert.equal(prepared.sectionRoleRows.find((row) => row.role === 'operator').visible, false)
  assert.equal(prepared.assignmentRows.find((row) => row.role === 'operator').section_id, sectionId)
  assert.equal(prepared.assignmentRows.find((row) => row.role === 'admin').is_locked, false)
  assert.equal(prepared.assignmentRows.find((row) => row.role === 'admin').prerequisite_video_id, null)
  assert.equal(prepared.assignmentRows.find((row) => row.role === 'salesperson').is_locked, true)
})
