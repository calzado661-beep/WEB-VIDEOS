import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getDriveDownloadUrl,
  getStorageObjectPath,
  getVideoExtension,
  normalizeVideoIds,
  readAdminSnapshot,
} from '../netlify/functions/import-drive-videos.js'
import { createClient } from '@supabase/supabase-js'
import { USER_ROLES } from '../src/data.js'

test('normaliza, deduplica y descarta identificadores de video inválidos', () => {
  assert.deepEqual(normalizeVideoIds([
    '550E8400-E29B-41D4-A716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
    'no-es-uuid',
  ]), ['550e8400-e29b-41d4-a716-446655440000'])
})

test('construye la descarga de Drive solo con un ID de archivo seguro', () => {
  const downloadUrl = new URL(getDriveDownloadUrl(
    '1AbCdEfGhIjKlMnOp',
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?resourcekey=0-safe_Key',
  ))
  assert.equal(downloadUrl.origin, 'https://drive.usercontent.google.com')
  assert.equal(downloadUrl.searchParams.get('id'), '1AbCdEfGhIjKlMnOp')
  assert.equal(downloadUrl.searchParams.get('resourcekey'), '0-safe_Key')
  assert.equal(getDriveDownloadUrl('https://evil.example/video.mp4'), '')
})

test('acepta solamente los formatos de video admitidos por Storage', () => {
  assert.equal(getVideoExtension('video/mp4; charset=binary'), 'mp4')
  assert.equal(getVideoExtension('video/webm'), 'webm')
  assert.equal(getVideoExtension('video/ogg'), 'ogg')
  assert.equal(getVideoExtension('text/html'), '')
})

test('la ruta privada pertenece al UUID del video y es estable para la fuente', () => {
  const videoId = '550e8400-e29b-41d4-a716-446655440000'
  const first = getStorageObjectPath(videoId, '1AbCdEfGhIjKlMnOp', 'mp4')
  const second = getStorageObjectPath(videoId, '1AbCdEfGhIjKlMnOp', 'mp4')
  const changed = getStorageObjectPath(videoId, '1DifferentDriveId', 'mp4')

  assert.match(first, /^550e8400-e29b-41d4-a716-446655440000\/drive-[a-f0-9]{16}\.mp4$/)
  assert.equal(first, second)
  assert.notEqual(first, changed)
})

test('importar desde Drive conserva todos los roles, bloqueos, requisitos y configuración de foto', async () => {
  const organizationId = '10000000-0000-4000-8000-000000000001'
  const sectionId = '20000000-0000-4000-8000-000000000001'
  const videoId = '30000000-0000-4000-8000-000000000001'
  const prerequisiteId = '30000000-0000-4000-8000-000000000002'
  const fixtures = {
    organizations: [{ id: organizationId, name: 'Demo', content_revision: 5 }],
    app_settings: [{ product_name: 'Portal', require_quiz_photo: true }],
    sections: [{ id: sectionId, name: 'Section' }],
    section_roles: USER_ROLES.map((role) => ({ section_id: sectionId, role, visible: true })),
    videos: [{ id: videoId }, { id: prerequisiteId }],
    video_assignments: USER_ROLES.map((role) => ({ video_id: videoId, section_id: sectionId, role, visible: true, is_locked: role === 'salesperson', prerequisite_video_id: role === 'admin' ? null : prerequisiteId })),
    video_sources: [{ video_id: videoId, provider: 'google_drive', source_ref: 'drive-file' }],
  }
  const client = createClient('https://import-test.supabase.co', 'test-key', { auth: { persistSession: false }, global: {
    fetch: async (input) => {
      const url = new URL(String(input))
      const table = url.pathname.split('/').at(-1)
      if (table !== 'video_sources') assert.equal(url.searchParams.get(table === 'organizations' ? 'id' : 'organization_id'), `eq.${organizationId}`)
      const fields = url.searchParams.get('select').split(',')
      const rows = fixtures[table].map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))))
      return new Response(JSON.stringify(['organizations', 'app_settings'].includes(table) ? rows[0] : rows), { headers: { 'content-type': 'application/json' } })
    },
  } })
  const { snapshot } = await readAdminSnapshot(client, organizationId)
  assert.equal(snapshot.settings.require_quiz_photo, true)
  assert.deepEqual(snapshot.section_roles.map((row) => row.role), USER_ROLES)
  assert.deepEqual(snapshot.video_assignments.map((row) => row.role), USER_ROLES)
  assert.ok(snapshot.video_assignments.filter((row) => row.role !== 'admin').every((row) => row.prerequisite_video_id === prerequisiteId))
  assert.equal(snapshot.video_assignments.find((row) => row.role === 'admin').prerequisite_video_id, null)
  assert.equal(snapshot.video_assignments.find((row) => row.role === 'salesperson').is_locked, true)
})
