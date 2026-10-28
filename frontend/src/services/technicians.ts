import { ApiError, apiRequest } from './api'
import type { Technician } from '../types/technicians'

export async function getTechnicians(signal?: AbortSignal): Promise<Technician[]> {
  const response = await apiRequest('/technicians', { signal }, 200)
  if (
    typeof response !== 'object' || response === null || !('data' in response) ||
    !Array.isArray(response.data) || !response.data.every((item: unknown) =>
      typeof item === 'object' && item !== null && 'id' in item && Number.isSafeInteger(item.id) &&
      typeof item.id === 'number' && item.id > 0 && 'name' in item && typeof item.name === 'string')
  ) throw new Error('A resposta de técnicos não possui o formato esperado.')

  return (response.data as Technician[]).map(({ id, name }) => ({ id, name }))
}

export function getTechniciansErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para carregar os técnicos.'
    if (cause.status === 403) return 'Você não tem permissão para consultar os técnicos.'
  }
  return 'Não foi possível carregar os técnicos. Verifique sua conexão e tente novamente.'
}
