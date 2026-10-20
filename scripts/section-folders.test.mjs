import assert from 'node:assert/strict'
import test from 'node:test'
import { canViewSection, canViewVideo, canViewDocument } from '../src/roleAccess.js'
import { getSectionLabel, getSectionTree, removeFolderFromSnapshot, validateSectionFolders } from '../src/sectionFolders.js'

const parent = { id: 's', name: 'Calidad', roles: ['operator', 'boss'], order: 0 }
const folder = { id: 'f', name: 'Manuales', parentId: 's', roles: ['operator', 'management'], order: 1 }
const sections = [parent, folder]

test('la carpeta requiere permiso propio y de la sección, incluso para enlaces directos', () => {
  const video = { assignments: { operator: 'f', boss: 'f', management: 'f' } }
  const document = { sectionId: 'f', audience: 'both' }
  for (const role of ['operator', 'boss', 'management']) {
    assert.equal(canViewSection(folder, role, sections), role === 'operator')
    assert.equal(canViewVideo(video, role, sections), role === 'operator')
    assert.equal(canViewDocument(document, role, sections), role === 'operator')
  }
  assert.equal(canViewSection(folder, 'operator', [folder]), false)
  assert.equal(canViewDocument(document, 'operator', [{ ...parent, roles: [] }, folder]), false)
  assert.equal(canViewSection(folder, 'admin', sections), true)
})

test('la navegación agrupa carpetas y rechaza ciclos o carpetas sin sección', () => {
  assert.equal(getSectionLabel(folder, sections), 'Calidad / Manuales')
  assert.deepEqual(getSectionTree([folder, parent]).map((item) => item.id), ['s', 'f'])
  assert.equal(validateSectionFolders(sections), '')
  assert.ok(validateSectionFolders([folder]))
  assert.ok(validateSectionFolders([{ ...parent, parentId: 'f' }, folder]))
  assert.ok(validateSectionFolders([...sections, { id: 'nested', parentId: 'f' }]))
})

test('eliminar una carpeta conserva archivos, títulos y permisos individuales al volver a la sección', () => {
  const video = { id: 'v', assignments: { operator: 'f', boss: 's' }, locked: { operator: true }, prerequisites: { operator: 'previous' } }
  const document = { id: 'd', sectionId: 'f', title: 'Documento', audience: 'operator', storageObjectPath: 'original/path.pdf' }
  const snapshot = { sections, videos: [video], documents: [document] }
  const updated = removeFolderFromSnapshot(snapshot, 'f')
  assert.deepEqual(updated.sections, [parent])
  assert.deepEqual(updated.videos[0].assignments, { operator: 's', boss: 's' })
  assert.deepEqual(updated.videos[0].locked, video.locked)
  assert.deepEqual(updated.videos[0].prerequisites, video.prerequisites)
  assert.deepEqual(updated.documents[0], { ...document, sectionId: 's' })
  assert.equal(snapshot.documents[0].sectionId, 'f')
})
