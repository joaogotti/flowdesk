import type { UserRole } from './auth'

export interface CreateAdminUserInput {
  name: string
  email: string
  role: 'requester' | 'technician'
  password: string
  password_confirmation: string
}

export type AdminUserFormValues = Omit<CreateAdminUserInput, 'role'> & { role: CreateAdminUserInput['role'] | '' }
export type AdminUserFormErrors = Partial<Record<keyof AdminUserFormValues, string>>

export type AdminUserEditValues = Pick<AdminUser, 'name' | 'email'>
export type UpdateAdminUserInput = Partial<AdminUserEditValues> & { expected_name?: string; expected_email?: string }
export type AdminUserEditErrors = Partial<Record<keyof AdminUserEditValues, string>>

export interface UpdateAdminUserRoleInput {
  role: UserRole
  expected_role: UserRole
}

export interface UpdateAdminUserStatusInput {
  is_active: boolean
  expected_is_active: boolean
}

export interface AdminUser {
  id: number
  name: string
  email: string
  role: UserRole
  disabled_at: string | null
  created_at: string | null
}

export interface AdminUserFilters {
  search: string
  role: UserRole | ''
  status: 'active' | 'disabled' | ''
  page: number
  per_page: number
}

export interface AdminUsersResponse {
  data: AdminUser[]
  current_page: number
  last_page: number
  per_page: number
  total: number
  from: number | null
  to: number | null
  first_page_url: string
  last_page_url: string
  next_page_url: string | null
  prev_page_url: string | null
  path: string
  links: { url: string | null; label: string; active: boolean }[]
}
