// Centraliza a URL base da API e remove barras finais para compor os endpoints.
export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '')

export type ValidationErrors = Record<string, string[]>

let sessionGeneration = 0
let confirmedIdentity = false
export type AuthenticationLossReason = 'expired' | 'revoked' | 'logout' | 'password_changed'
export interface AuthenticationLoss { reason: AuthenticationLossReason; wasAuthenticated: boolean; generation: number }
type RequestScope = 'protected' | 'login' | 'csrf' | 'public'
interface ApiRequestOptions extends RequestInit { authenticationGeneration?: number }
const authenticationListeners = new Set<(event: AuthenticationLoss) => void>()
const pendingRequests = new Map<AbortController, number>()

export class ObsoleteRequestError extends Error {
  constructor() { super('A requisição pertence a uma autenticação anterior.'); this.name = 'ObsoleteRequestError' }
}

export function getAuthenticationGeneration(): number { return sessionGeneration }

export function assertAuthenticationGeneration(generation: number): void {
  if (generation !== sessionGeneration) throw new ObsoleteRequestError()
}

function advanceGeneration() {
  sessionGeneration++
  confirmedIdentity = false
  for (const [controller, generation] of [...pendingRequests]) {
    if (generation !== sessionGeneration) controller.abort()
  }
}

export function beginAuthentication(): number {
  advanceGeneration()
  return sessionGeneration
}

export function confirmAuthentication(generation: number): void {
  assertAuthenticationGeneration(generation)
  confirmedIdentity = true
}

export function endAuthentication(reason: AuthenticationLossReason, generation: number): void {
  if (generation !== sessionGeneration) return
  const event = { reason, wasAuthenticated: confirmedIdentity, generation: sessionGeneration + 1 }
  advanceGeneration()
  authenticationListeners.forEach(listener => listener(event))
}

export function onAuthenticationLost(listener: (event: AuthenticationLoss) => void): () => void {
  authenticationListeners.add(listener)
  return () => { authenticationListeners.delete(listener) }
}

export function onSessionRevoked(listener: () => void): () => void {
  return onAuthenticationLost(event => { if (event.reason === 'revoked') listener() })
}

export function getAuthenticationLossMessage(event: AuthenticationLoss): string | null {
  if (event.reason === 'password_changed') return 'Senha alterada. Entre novamente com a nova senha.'
  if (event.reason === 'revoked') return 'Sua sessão foi revogada. Entre novamente.'
  return event.reason === 'expired' && event.wasAuthenticated ? 'Sua sessão expirou. Entre novamente.' : null
}

export class ApiError extends Error {
  readonly status: number
  readonly validationErrors: ValidationErrors
  readonly validationMessage: string | undefined
  readonly code: string | undefined
  readonly scope: RequestScope | undefined

  constructor(
    status: number,
    validationErrors: ValidationErrors = {},
    validationMessage?: string,
    code?: string,
    scope?: RequestScope,
  ) {
    const messages: Record<number, string> = {
      401: 'É necessário autenticar-se para continuar.',
      403: 'Você não tem permissão para realizar esta ação.',
      419: 'A sessão expirou ou a verificação CSRF falhou.',
      422: 'Verifique os dados informados.',
    }

    super(
      status >= 500
        ? 'Não foi possível concluir a solicitação. Tente novamente mais tarde.'
        : (messages[status] ?? `A solicitação falhou (HTTP ${status}).`),
    )
    this.name = 'ApiError'
    this.status = status
    this.validationErrors = validationErrors
    this.validationMessage = validationMessage
    this.code = code
    this.scope = scope
  }
}

function getApiUrl(): URL {
  if (!API_BASE_URL) {
    throw new Error('A URL da API não está configurada em VITE_API_URL.')
  }

  try {
    const url = new URL(API_BASE_URL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported protocol')
    }
    return url
  } catch {
    throw new Error('A URL da API configurada em VITE_API_URL é inválida.')
  }
}

function getXsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined

  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('XSRF-TOKEN='))

  if (!cookie) return undefined

  try {
    return decodeURIComponent(cookie.slice('XSRF-TOKEN='.length))
  } catch {
    throw new Error('Não foi possível ler o cookie CSRF. Inicialize-o novamente.')
  }
}

function getValidationErrors(data: unknown): ValidationErrors {
  if (typeof data !== 'object' || data === null || !('errors' in data)) return {}

  const errors = data.errors
  if (typeof errors !== 'object' || errors === null) return {}

  return Object.fromEntries(
    Object.entries(errors).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].every((message: unknown) => typeof message === 'string'),
    ),
  )
}

async function request(url: string, options: ApiRequestOptions, expectedStatus?: number, format: 'json' | 'blob' = 'json', scope: RequestScope = 'protected'): Promise<unknown> {
  const { authenticationGeneration: generation = sessionGeneration, ...fetchOptions } = options
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const assertCurrent = () => {
    assertAuthenticationGeneration(generation)
    if (controller.signal.aborted || options.signal?.aborted) {
      const error = new Error('Requisição cancelada.'); error.name = 'AbortError'; throw error
    }
  }
  assertCurrent()
  options.signal?.addEventListener('abort', cancel, { once: true })
  pendingRequests.set(controller, generation)
  try {
    const method = (options.method ?? 'GET').toUpperCase()
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const token = getXsrfToken()
      if (token) headers.set('X-XSRF-TOKEN', token)
    }

    let response: Response
    try {
      response = await fetch(url, {
        ...fetchOptions,
        method,
        headers,
        credentials: 'include',
        signal: controller.signal,
      })
    } catch (cause) {
      assertCurrent()
      throw new Error('Não foi possível conectar à API.', { cause })
    }

    assertCurrent()

    if (response.ok && expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new Error('A API não confirmou o resultado esperado. Consulte a listagem antes de tentar novamente.')
    }

    if (
      response.ok &&
      (response.status === 204 || response.status === 205 || method === 'HEAD')
    ) {
      assertCurrent()
      return undefined
    }

    if (response.ok && format === 'blob') {
      const blob = await response.blob()
      assertCurrent()
      return blob
    }

    let data: unknown
    try {
      const text = await response.text()
      data = text.trim() ? (JSON.parse(text) as unknown) : undefined
    } catch (cause) {
      assertCurrent()
      if (!response.ok) {
        if (response.status === 401 && scope === 'protected') endAuthentication('expired', generation)
        throw new ApiError(response.status, {}, undefined, undefined, scope)
      }
      throw new Error('Não foi possível ler a resposta JSON da API.', { cause })
    }

    assertCurrent()

    if (!response.ok) {
      const code = [401, 409, 422].includes(response.status) &&
        typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string'
        ? data.code : undefined
      if (response.status === 401 && scope === 'protected') endAuthentication(code === 'session_revoked' ? 'revoked' : 'expired', generation)
      throw new ApiError(
        response.status,
        response.status === 422 ? getValidationErrors(data) : {},
        response.status === 422 &&
          typeof data === 'object' &&
          data !== null &&
          'message' in data &&
          typeof data.message === 'string'
          ? data.message
          : undefined,
        code,
        scope,
      )
    }

    // Only this endpoint's confirmed success ends authentication; malformed 200s do not.
    if (scope === 'protected' && method === 'PUT' && url === `${API_BASE_URL}/user/password` && response.status === 200 &&
      typeof data === 'object' && data !== null && 'code' in data && data.code === 'password_changed' &&
      'reauthentication_required' in data && data.reauthentication_required === true) endAuthentication('password_changed', generation)
    return data
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    pendingRequests.delete(controller)
  }
}

export function apiRequest(
  path: string,
  options: ApiRequestOptions = {},
  expectedStatus?: number,
): Promise<unknown> {
  getApiUrl()
  const normalized = path.replace(/^\/+/, '')
  const endpoint = normalized.split('?')[0]
  const scope = endpoint === 'login' && (options.method ?? 'GET').toUpperCase() === 'POST' ? 'login' : endpoint === 'health' ? 'public' : 'protected'
  return request(`${API_BASE_URL}/${normalized}`, options, expectedStatus, 'json', scope)
}

// Binary responses share cookies, error parsing and session revocation with JSON requests.
export function apiBlobRequest(path: string, options: ApiRequestOptions = {}): Promise<Blob> {
  getApiUrl()
  return request(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`, { ...options, cache: 'no-store' }, 200, 'blob') as Promise<Blob>
}

// A inicialização deve ser solicitada explicitamente antes do futuro login.
export async function initializeCsrf(generation = sessionGeneration): Promise<number> {
  await request(`${getApiUrl().origin}/sanctum/csrf-cookie`, { method: 'GET', authenticationGeneration: generation }, undefined, 'json', 'csrf')
  assertAuthenticationGeneration(generation)
  return generation
}
