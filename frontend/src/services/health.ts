import type { HealthResponse } from '../types/health'
import { ApiError, apiRequest } from './api'

// Consulta a saúde da API e informa falhas de conexão, HTTP ou de resposta.
export async function getHealth(): Promise<HealthResponse> {
  let data: unknown
  try {
    data = await apiRequest('/health')
  } catch (cause) {
    if (cause instanceof ApiError) {
      throw new Error(`Falha ao consultar a saúde da API (HTTP ${cause.status}).`, {
        cause,
      })
    }
    throw cause
  }

  if (
    typeof data !== 'object' ||
    data === null ||
    !('status' in data) ||
    typeof data.status !== 'string' ||
    !('application' in data) ||
    typeof data.application !== 'string'
  ) {
    throw new Error('A resposta da API não possui o formato esperado.')
  }

  return { status: data.status, application: data.application }
}
