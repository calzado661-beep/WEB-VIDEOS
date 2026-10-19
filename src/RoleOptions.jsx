import { DOCUMENT_AUDIENCE_LABELS, DOCUMENT_AUDIENCES, ROLE_META, USER_ROLES } from './data.js'

export function RoleOptions() {
  return USER_ROLES.map((role) => <option value={role} key={role}>{ROLE_META[role].label}</option>)
}

export function DocumentAudienceOptions() {
  return DOCUMENT_AUDIENCES.map((audience) => <option value={audience} key={audience}>{DOCUMENT_AUDIENCE_LABELS[audience]}</option>)
}

export function AdminAccessNotice() {
  return <div className="admin-access-note"><strong>{ROLE_META.admin.label}</strong><span>Acceso total automático a todo el contenido. No requiere asignación ni admite bloqueos por rol.</span></div>
}
