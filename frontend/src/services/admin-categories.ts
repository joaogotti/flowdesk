import { ApiError, apiRequest, initializeCsrf } from './api'
import type { AdminCategory, CreateCategoryInput, UpdateCategoryInput, UpdateCategoryStatusInput } from '../types/admin-categories'

export async function updateAdminCategoryStatus(id: number, input: UpdateCategoryStatusInput): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1 || typeof input.is_active !== 'boolean') throw new Error('Informe uma categoria e uma situação válidas.')
  const authenticationGeneration = await initializeCsrf()
  await apiRequest(`/admin/categories/${id}/status`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: input.is_active }),
  }, 200)
}

export function getCategoryStatusErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para alterar a situação da categoria.'
    if (cause.status === 403) return 'Você não tem permissão para alterar a situação de categorias ou sua conta está desativada.'
    if (cause.status === 404) return 'A categoria não existe ou não está disponível. Atualize a listagem.'
    if (cause.status === 422) return cause.validationErrors.is_active?.join(' ') || cause.validationErrors.payload?.join(' ') || 'Não foi possível alterar a situação. Atualize a listagem e tente novamente.'
  }
  return 'Não foi possível confirmar a alteração. Verifique sua conexão e atualize a listagem antes de tentar novamente.'
}

export function getCategoryNameValidationError(value: string): string | null {
  const name = value.trim()
  if (!name) return 'Informe o nome da categoria.'
  if (Array.from(name).length > 100) return 'O nome deve ter no máximo 100 caracteres.'
  if (name.includes('\0')) return 'O nome contém caracteres inválidos.'
  return null
}

function normalizedName(input: CreateCategoryInput): string {
  const error = getCategoryNameValidationError(input.name)
  if (error) throw new Error(error)
  return input.name.trim()
}

export async function createAdminCategory(input: CreateCategoryInput): Promise<void> {
  const name = normalizedName(input)
  const authenticationGeneration = await initializeCsrf()
  await apiRequest('/admin/categories', {
    authenticationGeneration, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }, 201)
}

export async function updateAdminCategory(id: number, input: UpdateCategoryInput): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Informe uma categoria válida.')
  const name = normalizedName(input)
  const authenticationGeneration = await initializeCsrf()
  await apiRequest(`/admin/categories/${id}`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }, 200)
}

export function getUpdateCategoryErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para editar a categoria.'
    if (cause.status === 403) return 'Você não tem permissão para editar categorias ou sua conta está desativada.'
    if (cause.status === 404) return 'A categoria não existe ou não está disponível. Atualize a listagem.'
    if (cause.status === 422) return cause.validationErrors.payload?.join(' ') || 'Verifique o nome informado e tente novamente.'
  }
  return 'Não foi possível confirmar a alteração. Seu texto foi mantido. Verifique sua conexão e atualize a listagem antes de tentar novamente.'
}

export function getCreateCategoryErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para cadastrar a categoria.'
    if (cause.status === 403) return 'Você não tem permissão para cadastrar categorias ou sua conta está desativada.'
    if (cause.status === 422) return cause.validationErrors.payload?.join(' ') || 'Verifique o nome informado e tente novamente.'
  }
  return 'Não foi possível confirmar o cadastro. Seu texto foi mantido. Verifique sua conexão e consulte a listagem antes de tentar novamente.'
}

export async function getAdminCategories(signal?: AbortSignal): Promise<AdminCategory[]> {
  const response = await apiRequest('/admin/categories', { signal }, 200)
  if (
    typeof response !== 'object' || response === null ||
    !('data' in response) || !Array.isArray(response.data) ||
    !response.data.every((category: unknown): category is AdminCategory =>
      typeof category === 'object' && category !== null &&
      'id' in category && typeof category.id === 'number' && Number.isSafeInteger(category.id) && category.id > 0 &&
      'name' in category && typeof category.name === 'string' && category.name.trim().length > 0 &&
      'is_active' in category && typeof category.is_active === 'boolean' &&
      'tickets_count' in category && typeof category.tickets_count === 'number' && Number.isSafeInteger(category.tickets_count) && category.tickets_count >= 0,
    ) || new Set(response.data.map((category: AdminCategory) => category.id)).size !== response.data.length
  ) {
    throw new Error('A resposta de categorias não possui o formato esperado.')
  }

  return response.data.map(({ id, name, is_active, tickets_count }: AdminCategory) => ({ id, name, is_active, tickets_count }))
}
