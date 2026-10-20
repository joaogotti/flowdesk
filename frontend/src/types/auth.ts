export type UserRole = 'requester' | 'technician' | 'admin'

export interface AuthenticatedUser {
  id: number
  name: string
  email: string
  role: UserRole
}

export type LoginResponse = AuthenticatedUser

export interface LoginCredentials {
  email: string
  password: string
}
