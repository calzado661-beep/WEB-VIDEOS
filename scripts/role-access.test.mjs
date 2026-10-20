import assert from 'node:assert/strict'
import test from 'node:test'
import { USER_ROLES, ROLE_META } from '../src/data.js'
import { getDocumentAudienceLabel, isDocumentAudience, toggleDocumentAudienceRole } from '../src/documentAudience.js'
import { canViewDocument, canViewSection, canViewVideo, isVideoLockedForRole, matchesUserSearch, videoBelongsToSection } from '../src/roleAccess.js'

const sections = [{ id: 'sales', roles: ['salesperson'] }, { id: 'management', roles: ['management'] }]
const video = { assignments: { salesperson: 'sales', management: 'management' }, locked: { salesperson: true } }

test('Administradores de contenido necesita permisos explícitos y admite bloqueos', () => {
  assert.equal(ROLE_META.administrator.fullAccess, false)
  assert.equal(canViewSection({ id: 's', roles: ['operator'] }, 'administrator'), false)
  assert.equal(canViewVideo(video, 'administrator', sections), false)
  const section = { id: 's', roles: ['administrator'] }
  const assigned = { assignments: { administrator: 's' }, locked: { administrator: true } }
  assert.equal(canViewVideo(assigned, 'administrator', [section]), true)
  assert.equal(isVideoLockedForRole(assigned, 'administrator'), true)
  assert.equal(canViewDocument({ sectionId: 's', audience: 'administrator' }, 'administrator', [section]), true)
  assert.equal(canViewDocument({ sectionId: 's', audience: 'admin' }, 'administrator', [section]), false)
})

test('los documentos admiten varios roles sin ampliar el acceso a otros roles', () => {
  const allSections = [{ id: 'all', roles: USER_ROLES }]
  const document = { sectionId: 'all', audience: 'operator,management' }
  for (const role of USER_ROLES) assert.equal(canViewDocument(document, role, allSections), ['admin', 'operator', 'management'].includes(role))
  assert.equal(canViewDocument(document, 'management', [{ id: 'all', roles: ['operator'] }]), false)
  assert.equal(getDocumentAudienceLabel(document.audience), 'Operarios, Gerencia')
  assert.equal(toggleDocumentAudienceRole('operator', 'management'), 'operator,management')
  assert.equal(toggleDocumentAudienceRole('operator,management', 'operator'), 'management')
  assert.equal(toggleDocumentAudienceRole('operator', 'operator'), 'admin')
  assert.equal(toggleDocumentAudienceRole('both', 'boss'), 'operator,salesperson,management,administrator')
  for (const value of ['both', 'admin', 'operator', 'operator,boss']) assert.equal(isDocumentAudience(value), true)
  for (const value of ['', null, [], 'both,operator', 'operator,unknown', 'operator,']) assert.equal(isDocumentAudience(value), false)
})

test('los cinco roles tienen acceso coherente a secciones, videos y documentos', () => {
  for (const role of USER_ROLES) {
    const fullSection = { id: 'all', roles: USER_ROLES.filter((item) => item !== 'admin') }
    assert.equal(canViewSection(fullSection, role), true)
    assert.equal(canViewVideo({ assignments: Object.fromEntries(USER_ROLES.map((item) => [item, 'all'])) }, role, [fullSection]), true)
    assert.equal(canViewDocument({ sectionId: 'all', audience: 'both' }, role, [fullSection]), true)
  }
  assert.equal(canViewVideo(video, 'operator', sections), false)
  assert.equal(canViewVideo(video, 'salesperson', sections), true)
  assert.equal(isVideoLockedForRole(video, 'salesperson'), true)
  assert.equal(canViewVideo(video, 'management', sections), true)
  assert.equal(isVideoLockedForRole(video, 'management'), false)
})

test('administradores ven todo sin heredar bloqueos y los roles desconocidos fallan cerrados', () => {
  assert.equal(canViewVideo({ ...video, learningLocked: { admin: true } }, 'admin', []), true)
  assert.equal(isVideoLockedForRole(video, 'admin'), false)
  assert.equal(canViewSection({ id: 'private', roles: [] }, 'admin'), true)
  assert.equal(canViewDocument({ sectionId: 'sales', audience: 'admin' }, 'admin', sections), true)
  for (const role of ['operator', 'boss', 'salesperson', 'management', 'superadmin', '']) {
    assert.equal(canViewDocument({ sectionId: 'sales', audience: 'admin' }, role, sections), false)
  }
  assert.equal(canViewVideo(video, 'superadmin', sections), false)
  assert.equal(canViewSection(sections[0], 'superadmin'), false)
})

test('una sección oculta y una audiencia distinta impiden acceder al contenido', () => {
  assert.equal(canViewVideo(video, 'salesperson', [{ id: 'sales', roles: [] }]), false)
  assert.equal(canViewDocument({ sectionId: 'sales', audience: 'management' }, 'salesperson', sections), false)
  assert.equal(canViewDocument({ sectionId: 'sales', audience: 'both' }, 'salesperson', [{ id: 'sales', roles: [] }]), false)
  assert.equal(videoBelongsToSection(video, 'admin', 'management'), true)
  assert.equal(videoBelongsToSection(video, 'salesperson', 'management'), false)
})

test('la búsqueda de personas incluye los cinco roles e ignora tildes', () => {
  for (const role of USER_ROLES) assert.equal(matchesUserSearch({ role }, ROLE_META[role].label), true)
  assert.equal(matchesUserSearch({ department: 'Tecnología' }, 'tecnologia'), true)
})
