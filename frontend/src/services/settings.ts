import { ApiError, apiRequest, initializeCsrf } from './api'
import { parseUser } from './auth'
import type { AuthenticatedUser } from '../types/auth'

export interface PasswordChangeInput {
  current_password: string
  password: string
  password_confirmation: string
}

export async function updateOwnName(name: string, expectedName: string, signal?: AbortSignal): Promise<AuthenticatedUser> {
  const authenticationGeneration = await initializeCsrf()
  const response = await apiRequest('/user/profile', {
    method: 'PATCH', signal, authenticationGeneration,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, expected_name: expectedName }),
  }, 200)
  if (typeof response !== 'object' || response === null || !('data' in response)) {
    throw new Error('A API não confirmou os dados do perfil. Atualize os dados antes de tentar novamente.')
  }
  return parseUser(response.data)
}

export async function changeOwnPassword(values: PasswordChangeInput, signal?: AbortSignal): Promise<void> {
  const authenticationGeneration = await initializeCsrf()
  // Construct an allowlist instead of serializing caller-supplied extra attributes.
  const result = await apiRequest('/user/password', {
    method: 'PUT', signal, authenticationGeneration,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: values.current_password, password: values.password, password_confirmation: values.password_confirmation }),
  }, 200)
  if (typeof result !== 'object' || result === null || !('code' in result) || result.code !== 'password_changed' ||
    !('reauthentication_required' in result) || result.reauthentication_required !== true) {
    throw new Error('A API não confirmou a alteração da senha. Não repita automaticamente a operação; verifique sua sessão.')
  }
}

export function getSettingsErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return cause.scope === 'csrf' ? 'Não foi possível inicializar a sessão. Tente novamente.' : 'Entre novamente para continuar.'
      case 403: return 'Você não tem permissão para realizar esta ação.'
      case 409: return cause.code === 'profile_changed'
        ? 'Seus dados foram modificados por outra sessão. Sua edição foi preservada. Atualize os dados e revise antes de salvar.'
        : 'Não foi possível concluir a alteração. Atualize os dados antes de tentar novamente.'
      case 419: return 'Não foi possível validar a solicitação. Atualize a página e tente novamente.'
      case 422: return 'Verifique os campos informados.'
      case 429: return 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.'
    }
  }
  return 'Não foi possível confirmar a operação. Verifique sua sessão antes de tentar novamente.'
}
