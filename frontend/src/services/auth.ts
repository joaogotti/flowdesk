import type { AuthenticatedUser, LoginCredentials, LoginResponse } from '../types/auth'
import { ApiError, apiRequest, assertAuthenticationGeneration, beginAuthentication, confirmAuthentication, endAuthentication, getAuthenticationGeneration, initializeCsrf } from './api'

export function parseUser(data: unknown): AuthenticatedUser {
  if (
    typeof data !== 'object' || data === null ||
    !('id' in data) || typeof data.id !== 'number' ||
    !('name' in data) || typeof data.name !== 'string' ||
    !('email' in data) || typeof data.email !== 'string' ||
    !('role' in data) ||
    (data.role !== 'requester' && data.role !== 'technician' && data.role !== 'admin')
  ) {
    throw new Error('A resposta de autenticação não possui o formato esperado.')
  }

  // Mantém somente os atributos permitidos, mesmo se a API enviar campos extras.
  return { id: data.id, name: data.name, email: data.email, role: data.role }
}

export async function login(credentials: LoginCredentials, generation = beginAuthentication()): Promise<LoginResponse> {
  await initializeCsrf(generation)

  const user = parseUser(await apiRequest('/login', {
    method: 'POST',
    authenticationGeneration: generation,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  }, 200))
  confirmAuthentication(generation)
  return user
}

export async function logout(generation = getAuthenticationGeneration()): Promise<void> {
  await initializeCsrf(generation)
  await apiRequest('/logout', { method: 'POST', authenticationGeneration: generation }, 204)
  endAuthentication('logout', generation)
}

let pendingUserRequest: { generation: number; promise: Promise<AuthenticatedUser> } | null = null

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  // Compartilha apenas a consulta em andamento, inclusive no Strict Mode.
  // O resultado não é armazenado: a próxima consulta verifica a sessão novamente.
  const generation = getAuthenticationGeneration()
  if (pendingUserRequest?.generation !== generation) {
    const promise = apiRequest('/user', { authenticationGeneration: generation, cache: 'no-store' }).then(data => {
      assertAuthenticationGeneration(generation)
      const user = parseUser(data)
      confirmAuthentication(generation)
      return user
    }).finally(() => { if (pendingUserRequest?.promise === promise) pendingUserRequest = null })
    pendingUserRequest = { generation, promise }
  }
  return pendingUserRequest.promise
}

export function getAuthErrorMessage(cause: unknown, context: 'login' | 'session'): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401:
        if (cause.scope === 'csrf') return 'Não foi possível inicializar a sessão. Tente novamente.'
        return context === 'login'
          ? 'E-mail ou senha inválidos.'
          : 'Não foi possível confirmar sua sessão. Tente entrar novamente.'
      case 403:
        return 'Acesso não permitido. Entre em contato com o responsável pelo suporte.'
      case 419:
        return 'Sua sessão expirou. Tente entrar novamente.'
      case 422:
        return 'Verifique o e-mail e a senha informados.'
      case 429:
        return 'Muitas tentativas de acesso. Aguarde um momento e tente novamente.'
      default:
        return 'Não foi possível concluir o acesso. Tente novamente mais tarde.'
    }
  }

  return 'Não foi possível verificar o acesso. Verifique sua conexão e tente novamente.'
}
