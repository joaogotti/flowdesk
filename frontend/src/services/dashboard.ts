import { ApiError, apiRequest } from './api'
import type { DashboardCategory, DashboardSla, DashboardStats, RecentTicket } from '../types/dashboard'
import type { TicketReference } from '../types/tickets'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function getDashboardSla(signal?: AbortSignal): Promise<DashboardSla> {
  const response = await apiRequest('/dashboard/sla', { signal }, 200)
  const invalidResponse = 'A resposta de SLA não possui o formato esperado.'
  if (!isRecord(response) || !isRecord(response.data)) throw new Error(invalidResponse)

  const result = {} as DashboardSla
  for (const key of ['on_track', 'at_risk', 'overdue'] as const) {
    const value = response.data[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(invalidResponse)
    result[key] = value
  }
  return result
}

export function getDashboardSlaErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para carregar os prazos de atendimento.'
    if (cause.status === 403) return 'Você não tem permissão para consultar os prazos de atendimento. Entre em contato com o suporte.'
  }
  return 'Não foi possível carregar os prazos de atendimento. Verifique sua conexão e tente novamente.'
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isReference(value: unknown): value is TicketReference {
  return isRecord(value) && isId(value.id) && typeof value.name === 'string'
}

export async function getDashboardCategories(signal?: AbortSignal): Promise<DashboardCategory[]> {
  const response = await apiRequest('/dashboard/categories', { signal }, 200)
  const invalidResponse = 'A resposta de categorias do Dashboard não possui o formato esperado.'
  if (!isRecord(response) || !Array.isArray(response.data)) throw new Error(invalidResponse)

  const ids = new Set<number>()
  return response.data.map((category: unknown) => {
    if (!isRecord(category) || !isId(category.id) || ids.has(category.id) ||
      typeof category.name !== 'string' || !category.name.trim() ||
      typeof category.count !== 'number' || !Number.isSafeInteger(category.count) || category.count < 0) {
      throw new Error(invalidResponse)
    }
    ids.add(category.id)
    return { id: category.id, name: category.name, count: category.count }
  })
}

export function getDashboardCategoriesErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para carregar a organização da fila.'
    if (cause.status === 403) return 'Você não tem permissão para consultar a organização da fila. Entre em contato com o suporte.'
  }
  return 'Não foi possível carregar a organização da fila. Verifique sua conexão e tente novamente.'
}

export async function getRecentTickets(signal?: AbortSignal): Promise<RecentTicket[]> {
  const response = await apiRequest('/dashboard/recent-tickets', { signal }, 200)
  const invalidResponse = 'A resposta de chamados recentes não possui o formato esperado.'
  if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > 5) {
    throw new Error(invalidResponse)
  }

  const ids = new Set<number>()
  return response.data.map((ticket: unknown) => {
    if (!isRecord(ticket) || !isId(ticket.id) || ids.has(ticket.id) || typeof ticket.title !== 'string' ||
      !isRecord(ticket.status) || typeof ticket.status.code !== 'string' || typeof ticket.status.name !== 'string' ||
      !(ticket.assignee === null || isReference(ticket.assignee)) ||
      typeof ticket.updated_at !== 'string' || Number.isNaN(Date.parse(ticket.updated_at))) {
      throw new Error(invalidResponse)
    }
    ids.add(ticket.id)
    return {
      id: ticket.id, title: ticket.title,
      status: { code: ticket.status.code, name: ticket.status.name },
      assignee: ticket.assignee ? { id: ticket.assignee.id, name: ticket.assignee.name } : null,
      updated_at: ticket.updated_at,
    }
  })
}

export function getRecentTicketsErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para carregar os chamados recentes.'
    if (cause.status === 403) return 'Você não tem permissão para consultar os chamados recentes. Entre em contato com o suporte.'
  }
  return 'Não foi possível carregar os chamados recentes. Verifique sua conexão e tente novamente.'
}

export async function getDashboardStats(signal?: AbortSignal): Promise<DashboardStats> {
  const response = await apiRequest('/dashboard/stats', { signal }, 200)
  if (typeof response !== 'object' || response === null || !('data' in response) ||
    typeof response.data !== 'object' || response.data === null) {
    throw new Error('A resposta de indicadores não possui o formato esperado.')
  }

  const data = response.data as Record<string, unknown>
  const keys = ['total', 'open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled', 'unassigned'] as const
  const stats = {} as DashboardStats
  for (const key of keys) {
    if (!(key in data)) throw new Error('A resposta de indicadores não possui o formato esperado.')
    const value = data[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('A resposta de indicadores não possui o formato esperado.')
    }
    stats[key] = value
  }

  return stats
}

export function getDashboardErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 419) return 'Sua sessão expirou. Entre novamente para carregar os indicadores.'
    if (cause.status === 403) return 'Você não tem permissão para consultar os indicadores. Entre em contato com o suporte.'
  }

  return 'Não foi possível carregar os indicadores. Verifique sua conexão e tente novamente.'
}
