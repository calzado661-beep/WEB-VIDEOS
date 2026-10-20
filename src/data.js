export const ROLE_META = {
  admin: { label: 'Administrador de la página', short: 'AP', description: 'Gestiona usuarios, contenido y configuración. Acceso a todo el contenido de su organización.', fullAccess: true },
  operator: { label: 'Operarios', short: 'OP', description: 'Acceden al contenido habilitado para Operarios.', fullAccess: false },
  boss: { label: 'Jefes', short: 'JF', description: 'Acceden al contenido habilitado para Jefes.', fullAccess: false },
  salesperson: { label: 'Vendedores', short: 'VD', description: 'Acceden al contenido habilitado para Vendedores.', fullAccess: false },
  management: { label: 'Gerencia', short: 'GR', description: 'Acceden al contenido habilitado para Gerencia. No concede permisos de administración.', fullAccess: false },
  administrator: { label: 'Administradores', short: 'AD', description: 'Acceden al contenido habilitado para Administradores. No concede permisos para gestionar la página.', fullAccess: false },
}

export const USER_ROLES = Object.keys(ROLE_META)
export const VIEWER_ROLES = USER_ROLES.filter((role) => !ROLE_META[role].fullAccess)
export const DOCUMENT_AUDIENCES = ['both', ...USER_ROLES]
export const DOCUMENT_AUDIENCE_LABELS = {
  both: 'Todos los roles de la sección',
  ...Object.fromEntries(USER_ROLES.map((role) => [role, role === 'admin' ? 'Solo gestión de la página' : ROLE_META[role].label])),
}

export const getRoleLabel = (role) => ROLE_META[role]?.label || role || 'Sin rol'
export const hasFullContentAccess = (role) => ROLE_META[role]?.fullAccess === true
