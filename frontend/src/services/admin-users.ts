import { ApiError, apiRequest, initializeCsrf } from './api'
import type { AdminUser, AdminUserFilters, AdminUsersResponse, CreateAdminUserInput, UpdateAdminUserInput, UpdateAdminUserRoleInput, UpdateAdminUserStatusInput } from '../types/admin-users'
import { isUserRole } from '../utils/admin-user-role'
import { roleLabels } from '../utils/user'
import { normalizeAdminUserEditValues, validateAdminUserEditForm, validateAdminUserForm } from '../utils/admin-user-form'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value)))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isAdminUser(value: unknown): value is AdminUser {
  return isRecord(value) && isInteger(value.id, 1) &&
    typeof value.name === 'string' && value.name.trim().length > 0 &&
    typeof value.email === 'string' && value.email.trim().length > 0 &&
    typeof value.role === 'string' && Object.hasOwn(roleLabels, value.role) &&
    isNullableDate(value.disabled_at) && isNullableDate(value.created_at)
}

function parseAdminUsers(value: unknown): AdminUsersResponse {
  if (!isRecord(value) || !Array.isArray(value.data) || !value.data.every(isAdminUser) ||
    !isInteger(value.current_page, 1) || !isInteger(value.last_page, 1) || !isInteger(value.total, 0) ||
    !isInteger(value.per_page, 1) || value.per_page > 100 || value.data.length > value.per_page ||
    value.last_page !== Math.max(1, Math.ceil(value.total / value.per_page)) ||
    new Set(value.data.map(user => user.id)).size !== value.data.length ||
    typeof value.first_page_url !== 'string' || typeof value.last_page_url !== 'string' || typeof value.path !== 'string' ||
    !isNullableString(value.next_page_url) || !isNullableString(value.prev_page_url) ||
    !Array.isArray(value.links) || !value.links.every(link => isRecord(link) && isNullableString(link.url) && typeof link.label === 'string' && typeof link.active === 'boolean')) {
    throw new Error('A resposta da listagem de usuários não possui o formato esperado.')
  }
  const expectedFrom = value.data.length ? (value.current_page - 1) * value.per_page + 1 : null
  const expectedTo = expectedFrom === null ? null : expectedFrom + value.data.length - 1
  if (value.from !== expectedFrom || value.to !== expectedTo || (expectedTo !== null && expectedTo > value.total)) {
    throw new Error('A paginação de usuários não possui o formato esperado.')
  }
  return {
    data: value.data.map(({ id, name, email, role, disabled_at, created_at }) => ({ id, name, email, role, disabled_at, created_at })),
    current_page: value.current_page, last_page: value.last_page, per_page: value.per_page, total: value.total,
    from: value.from as number | null, to: value.to as number | null,
    first_page_url: value.first_page_url, last_page_url: value.last_page_url, path: value.path,
    next_page_url: value.next_page_url, prev_page_url: value.prev_page_url,
    links: value.links.map(link => ({ url: link.url as string | null, label: link.label as string, active: link.active as boolean })),
  }
}

export async function getAdminUsers(filters: AdminUserFilters, signal?: AbortSignal): Promise<AdminUsersResponse> {
  const search = filters.search.trim()
  if (!isInteger(filters.page, 1) || filters.page > 1000000 || !isInteger(filters.per_page, 1) || filters.per_page > 100 ||
    search.length > 255 || search.includes('\0') ||
    (filters.role !== '' && !Object.hasOwn(roleLabels, filters.role)) || !['', 'active', 'disabled'].includes(filters.status)) {
    throw new Error('Informe filtros válidos para consultar os usuários.')
  }
  const params = new URLSearchParams({ page: String(filters.page), per_page: String(filters.per_page) })
  if (search) params.set('search', search)
  if (filters.role) params.set('role', filters.role)
  if (filters.status) params.set('status', filters.status)
  return parseAdminUsers(await apiRequest(`/admin/users?${params}`, { signal }, 200))
}

export function getAdminUsersErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para consultar os usuários.'
    if (cause.status === 403) return 'Você não tem permissão para consultar usuários ou sua conta está desativada.'
    if (cause.status === 422) return Object.values(cause.validationErrors).flat().join(' ') || 'Verifique os filtros informados e tente novamente.'
  }
  return 'Não foi possível carregar os usuários. Verifique sua conexão e tente novamente.'
}

export async function createAdminUser(input: CreateAdminUserInput): Promise<AdminUser> {
  if (Object.keys(validateAdminUserForm(input)).length) throw new Error('Verifique os dados do cadastro.')
  const payload: CreateAdminUserInput = {
    name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role,
    password: input.password, password_confirmation: input.password_confirmation,
  }
  const authenticationGeneration = await initializeCsrf()
  const response = await apiRequest('/admin/users', {
    authenticationGeneration, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }, 201)
  if (!isRecord(response) || !isAdminUser(response.data) || response.data.role === 'admin' || response.data.disabled_at !== null) {
    throw new Error('Não foi possível confirmar os dados do usuário cadastrado.')
  }
  const { id, name, email, role, disabled_at, created_at } = response.data
  return { id, name, email, role, disabled_at, created_at }
}

export function getCreateAdminUserErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para cadastrar usuários.'
    if (cause.status === 403) return 'Você não tem permissão para cadastrar usuários ou sua conta está desativada.'
    if (cause.status === 422) return 'Verifique os campos indicados e tente novamente.'
  }
  return 'Não foi possível confirmar o cadastro. Consulte a listagem antes de tentar novamente para evitar duplicidade.'
}

export async function updateAdminUser(id: number, input: UpdateAdminUserInput): Promise<AdminUser> {
  if (!isInteger(id, 1) || Object.keys(validateAdminUserEditForm(input)).length) throw new Error('Verifique os dados da edição.')
  for (const field of ['name', 'email'] as const) {
    const expected = input[`expected_${field}`]
    if (Object.hasOwn(input, field) !== Object.hasOwn(input, `expected_${field}`) ||
      (Object.hasOwn(input, field) && (typeof expected !== 'string' || !expected.trim() || Array.from(expected).length > 255 || expected.includes('\0')))) {
      throw new Error('Informe os valores originais dos campos alterados.')
    }
  }
  const normalized = normalizeAdminUserEditValues({ name: input.name ?? '', email: input.email ?? '' })
  const payload: UpdateAdminUserInput = {
    ...(Object.hasOwn(input, 'name') ? { name: normalized.name, expected_name: input.expected_name } : {}),
    ...(Object.hasOwn(input, 'email') ? { email: normalized.email, expected_email: input.expected_email } : {}),
  }
  if (!Object.keys(payload).length) throw new Error('Informe ao menos nome ou e-mail.')
  const authenticationGeneration = await initializeCsrf()
  const response = await apiRequest(`/admin/users/${id}`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }, 200)
  if (!isRecord(response) || !isAdminUser(response.data) || response.data.id !== id) {
    throw new Error('Não foi possível confirmar os dados do usuário alterado.')
  }
  const { name, email, role, disabled_at, created_at } = response.data
  return { id, name, email, role, disabled_at, created_at }
}

export function getUpdateAdminUserErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para editar usuários.'
    if (cause.status === 403) return 'Você não tem permissão para editar usuários ou sua conta está desativada.'
    if (cause.status === 404) return 'Este usuário não existe mais. Atualize a listagem.'
    if (cause.status === 409 && cause.code === 'profile_changed') return 'Os dados deste usuário foram modificados por outra sessão. Atualize os dados e revise sua edição antes de salvar novamente.'
    if (cause.status === 422) return 'Verifique os campos indicados e tente novamente.'
  }
  return 'Não foi possível confirmar a alteração. Consulte a listagem antes de tentar novamente.'
}

export async function updateAdminUserRole(id: number, input: UpdateAdminUserRoleInput): Promise<AdminUser> {
  if (!isInteger(id, 1) || !isUserRole(input.role) || !isUserRole(input.expected_role) || input.role === input.expected_role) {
    throw new Error('Selecione um perfil diferente do atual.')
  }
  const payload: UpdateAdminUserRoleInput = { role: input.role, expected_role: input.expected_role }
  const authenticationGeneration = await initializeCsrf()
  const response = await apiRequest(`/admin/users/${id}/role`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }, 200)
  if (!isRecord(response) || !isAdminUser(response.data) || response.data.id !== id || response.data.role !== input.role || response.data.disabled_at !== null) {
    throw new Error('Não foi possível confirmar o perfil do usuário.')
  }
  const { name, email, role, disabled_at, created_at } = response.data
  return { id, name, email, role, disabled_at, created_at }
}

export function getUpdateAdminUserRoleErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para alterar perfis.'
    if (cause.status === 403) return 'Você não tem permissão para realizar esta alteração de perfil.'
    if (cause.status === 404) return 'Este usuário não existe mais. Atualize os dados da lista.'
    if (cause.status === 422) return 'Verifique o perfil selecionado. Se necessário, atualize os dados antes de tentar novamente.'
    if (cause.status === 409) {
      switch (cause.code) {
        case 'role_changed': return 'O perfil deste usuário foi alterado por outra pessoa. Atualize os dados antes de tentar novamente.'
        case 'active_assignments': return 'Este técnico possui chamados atribuídos que impedem a mudança de perfil. Confira os chamados antes de tentar novamente.'
        case 'last_active_admin': return 'O sistema precisa manter ao menos um administrador ativo. Atualize os dados antes de tentar novamente.'
        case 'target_disabled': return 'A conta foi desativada. Não é possível alterar seu perfil. Atualize os dados da lista.'
        default: return 'Há um conflito com os dados atuais do usuário. Atualize os dados antes de tentar novamente.'
      }
    }
  }
  return 'Não foi possível confirmar a alteração de perfil. Atualize os dados antes de tentar novamente.'
}

export async function updateAdminUserStatus(id: number, input: UpdateAdminUserStatusInput): Promise<AdminUser> {
  if (!isInteger(id, 1) || typeof input.is_active !== 'boolean' || typeof input.expected_is_active !== 'boolean' || input.is_active === input.expected_is_active) {
    throw new Error('Selecione uma situação diferente da atual.')
  }
  const payload: UpdateAdminUserStatusInput = { is_active: input.is_active, expected_is_active: input.expected_is_active }
  const authenticationGeneration = await initializeCsrf()
  const response = await apiRequest(`/admin/users/${id}/status`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }, 200)
  if (!isRecord(response) || !isAdminUser(response.data) || response.data.id !== id || (response.data.disabled_at === null) !== input.is_active) {
    throw new Error('Não foi possível confirmar a situação do usuário.')
  }
  const { name, email, role, disabled_at, created_at } = response.data
  return { id, name, email, role, disabled_at, created_at }
}

export function getUpdateAdminUserStatusErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para alterar a situação dos usuários.'
    if (cause.status === 403) return 'Você não tem permissão para alterar esta conta. Não é permitido desativar a própria conta.'
    if (cause.status === 404) return 'Este usuário não existe mais. Atualize os dados da lista.'
    if (cause.status === 422) return 'Não foi possível validar a situação solicitada. Atualize os dados antes de confirmar novamente.'
    if (cause.status === 409) {
      switch (cause.code) {
        case 'status_changed': return 'A situação deste usuário foi alterada por outra pessoa. Atualize os dados antes de tentar novamente.'
        case 'active_assignments': return 'Este técnico possui chamados atribuídos que impedem a desativação. Confira os chamados antes de tentar novamente.'
        case 'last_active_admin': return 'O sistema precisa manter ao menos um administrador ativo. Esta conta não pode ser desativada.'
        case 'session_version_exhausted': return 'Não foi possível renovar a autenticação desta conta. Entre em contato com o responsável pelo suporte.'
        default: return 'Há um conflito com a situação atual do usuário. Atualize os dados antes de tentar novamente.'
      }
    }
  }
  return 'Não foi possível confirmar a alteração de situação. Atualize os dados antes de tentar novamente.'
}
