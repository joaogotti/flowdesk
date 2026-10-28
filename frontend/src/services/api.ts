// Centraliza a URL base da API e remove barras finais para compor os endpoints.
export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '')

export type ValidationErrors = Record<string, string[]>

export class ApiError extends Error {
  readonly status: number
  readonly validationErrors: ValidationErrors
  readonly validationMessage: string | undefined
  readonly code: string | undefined

  constructor(
    status: number,
    validationErrors: ValidationErrors = {},
    validationMessage?: string,
    code?: string,
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

async function request(url: string, options: RequestInit, expectedStatus?: number): Promise<unknown> {
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
      ...options,
      method,
      headers,
      credentials: 'include',
    })
  } catch (cause) {
    throw new Error('Não foi possível conectar à API.', { cause })
  }

  if (response.ok && expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error('A API não confirmou o resultado esperado. Consulte a listagem antes de tentar novamente.')
  }

  if (
    response.ok &&
    (response.status === 204 || response.status === 205 || method === 'HEAD')
  ) {
    return undefined
  }

  let data: unknown
  try {
    const text = await response.text()
    data = text.trim() ? (JSON.parse(text) as unknown) : undefined
  } catch (cause) {
    if (!response.ok) throw new ApiError(response.status)
    throw new Error('Não foi possível ler a resposta JSON da API.', { cause })
  }

  if (!response.ok) {
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
      response.status === 409 &&
        typeof data === 'object' && data !== null &&
        'code' in data && typeof data.code === 'string'
        ? data.code
        : undefined,
    )
  }

  return data
}

export function apiRequest(
  path: string,
  options: RequestInit = {},
  expectedStatus?: number,
): Promise<unknown> {
  getApiUrl()
  return request(`${API_BASE_URL}/${path.replace(/^\/+/, '')}`, options, expectedStatus)
}

// A inicialização deve ser solicitada explicitamente antes do futuro login.
export async function initializeCsrf(): Promise<void> {
  await request(`${getApiUrl().origin}/sanctum/csrf-cookie`, { method: 'GET' })
}
