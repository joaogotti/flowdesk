import type { AdminUser } from '../types/admin-users'
import type { AuthenticatedUser } from '../types/auth'

export function canChangeAdminUserStatus(actor: Pick<AuthenticatedUser, 'id' | 'role'>, target: Pick<AdminUser, 'id'>): boolean {
  return actor.role === 'admin' && actor.id !== target.id
}
