import type { UserRole } from '../types/auth'

export const roleLabels: Record<UserRole, string> = {
  requester: 'Solicitante',
  technician: 'Técnico',
  admin: 'Administrador',
}

export function getUserInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toLocaleUpperCase('pt-BR') || 'FD'
}
