import { ApiError, apiRequest } from './api'
import type { CategoriesResponse, Category } from '../types/categories'

export async function getCategories(signal?: AbortSignal): Promise<Category[]> {
  const response = await apiRequest('/categories', { signal })
  if (
    typeof response !== 'object' || response === null ||
    !('data' in response) || !Array.isArray(response.data) ||
    !response.data.every((category: unknown) =>
      typeof category === 'object' && category !== null &&
      'id' in category && typeof category.id === 'number' && Number.isInteger(category.id) &&
      'name' in category && typeof category.name === 'string',
    )
  ) {
    throw new Error('A resposta de categorias não possui o formato esperado.')
  }

  return (response as CategoriesResponse).data.map(({ id, name }) => ({ id, name }))
}

export function getCategoriesErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para carregar as categorias.'
    if (cause.status === 403) return 'Você não tem permissão para consultar as categorias. Entre em contato com o suporte.'
  }

  return 'Não foi possível carregar as categorias. Verifique sua conexão e tente novamente.'
}
