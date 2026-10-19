import { ROLE_META, VIEWER_ROLES, hasFullContentAccess } from './data.js'

// Presentation checks match the database rules; Supabase RLS remains authoritative.
export function canViewSection(section, role) {
  return Boolean(ROLE_META[role] && section && section.active !== false
    && (hasFullContentAccess(role) || section.roles?.includes(role)))
}

export function canViewVideo(video, role, sections) {
  if (!ROLE_META[role] || !video || video.active === false) return false
  if (hasFullContentAccess(role)) return true
  return sections.some((section) => section.id === video.assignments?.[role] && canViewSection(section, role))
}

export function canViewDocument(document, role, sections) {
  if (!ROLE_META[role] || !document || document.active === false) return false
  if (!sections.some((section) => section.id === document.sectionId && canViewSection(section, role))) return false
  return hasFullContentAccess(role) || !document.audience || document.audience === 'both' || document.audience === role
}

export function videoBelongsToSection(video, role, sectionId) {
  return hasFullContentAccess(role)
    ? Object.values(video.assignments || {}).includes(sectionId)
    : Boolean(ROLE_META[role] && video.assignments?.[role] === sectionId)
}

export function isVideoAssignedToRole(video, role) {
  return Boolean(ROLE_META[role] && (hasFullContentAccess(role) || video.assignments?.[role]))
}

export function isVideoLockedForRole(video, role) {
  return !hasFullContentAccess(role) && isVideoAssignedToRole(video, role)
    && Boolean(video.locked?.[role] || video.learningLocked?.[role])
}

export function getAssignedViewerRoles(video) {
  return VIEWER_ROLES.filter((role) => Boolean(video.assignments?.[role]))
}

export function normalizeSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

export function matchesUserSearch(user, query) {
  return normalizeSearch([user.displayName, user.username, user.jobTitle, user.department, ROLE_META[user.role]?.label].join(' '))
    .includes(normalizeSearch(query))
}
