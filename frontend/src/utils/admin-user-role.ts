import type { AdminUser } from '../types/admin-users'
import type { AuthenticatedUser, UserRole } from '../types/auth'

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && ['requester', 'technician', 'admin'].includes(value)
}

export function canChangeAdminUserRole(actor: Pick<AuthenticatedUser, 'id' | 'role'>, target: Pick<AdminUser, 'id' | 'disabled_at'>): boolean {
  return actor.role === 'admin' && actor.id !== target.id && target.disabled_at === null
}

export const userRoleConsequences: Record<UserRole, string> = {
  requester: 'Terá acesso aos chamados que abriu e aos comentários públicos. Deixará de ter permissões técnicas e administrativas.',
  technician: 'Terá acesso aos chamados atribuídos a si e sem responsável, incluindo comentários internos. Poderá assumir chamados para si e atuar como técnico responsável. Chamados que abriu e foram atribuídos a outros técnicos podem deixar de ficar acessíveis.',
  admin: 'Terá acesso a todos os chamados, comentários internos e à administração de usuários e categorias.',
}
