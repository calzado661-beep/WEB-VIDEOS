import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('la subida exige gestión de la organización y explica el rechazo de Storage', async (t) => {
  const organizationId = '10000000-0000-4000-8000-000000000001'
  const sectionId = '20000000-0000-4000-8000-000000000001'
  let role = 'administrator', uploadError = null, uploads = 0
  globalThis.documentUploadTestClient = {
    rpc: async () => ({ data: { userId: 'u', organizationId, role, active: true }, error: null }),
    storage: { from: () => ({ upload: async () => { uploads += 1; return { error: uploadError } } }) },
    from: () => ({ insert: (row) => ({ select: () => ({ single: async () => ({ data: { ...row, created_at: new Date().toISOString(), sort_order: 0 }, error: null }) }) }) }),
  }
  const server = await createServer({ configFile: false, envDir: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, plugins: [{
    name: 'document-upload-api-mock', enforce: 'pre', transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/lib/supabase.js')) return 'export const isSupabaseConfigured = true; export const supabase = globalThis.documentUploadTestClient;'
    },
  }] })
  t.after(async () => { await server.close(); delete globalThis.documentUploadTestClient })
  const { uploadSectionDocument } = await server.ssrLoadModule('/src/lib/videoHubApi.js')
  const options = { organizationId, sectionId, title: 'Documento', audience: 'both', file: { name: 'test.pdf', type: 'application/pdf', size: 12 } }
  await assert.rejects(uploadSectionDocument(options), { code: 'DOCUMENT_UPLOAD_FORBIDDEN' })
  assert.equal(uploads, 0)
  role = 'admin'
  await assert.rejects(uploadSectionDocument({ ...options, organizationId: '10000000-0000-4000-8000-000000000002' }), { code: 'DOCUMENT_UPLOAD_FORBIDDEN' })
  assert.equal(uploads, 0)
  uploadError = { message: 'new row violates row-level security policy' }
  await assert.rejects(uploadSectionDocument(options), { code: 'DOCUMENT_STORAGE_POLICY_DENIED' })
  uploadError = null
  const document = await uploadSectionDocument(options)
  assert.equal(document.title, 'Documento')
  assert.equal(document.sectionId, sectionId)
  assert.equal(uploads, 2)
})
