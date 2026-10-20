import { DOCUMENT_AUDIENCE_LABELS, USER_ROLES, VIEWER_ROLES } from './data.js'

// Keep legacy single-role values and "both" compatible with existing documents.
export function isDocumentAudience(value) {
  return typeof value === 'string' && (value === 'both'
    || (value.length > 0 && value.split(',').every((role) => USER_ROLES.includes(role))))
}

export function getDocumentAudienceRoles(value = 'both') {
  return value === 'both' ? VIEWER_ROLES : String(value).split(',').filter((role) => VIEWER_ROLES.includes(role))
}

export function getDocumentAudienceLabel(value = 'both') {
  return DOCUMENT_AUDIENCE_LABELS[value]
    || getDocumentAudienceRoles(value).map((role) => DOCUMENT_AUDIENCE_LABELS[role]).join(', ')
}

export function toggleDocumentAudienceRole(value, role) {
  const selected = getDocumentAudienceRoles(value)
  const roles = VIEWER_ROLES.filter((item) => item === role ? !selected.includes(item) : selected.includes(item))
  return roles.join(',') || 'admin'
}
