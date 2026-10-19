export const ROLE_META = {
  admin: { label: 'Administradores', short: 'AD' },
  operator: { label: 'Operarios', short: 'OP' },
  boss: { label: 'Jefes', short: 'JF' },
  salesperson: { label: 'Vendedores', short: 'VD' },
  management: { label: 'Gerencia', short: 'GR' },
}

export const USER_ROLES = Object.keys(ROLE_META)
export const VIEWER_ROLES = USER_ROLES.filter((role) => role !== 'admin')
