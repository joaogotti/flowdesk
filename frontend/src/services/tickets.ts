import { ApiError, apiRequest, initializeCsrf } from './api'
import { ticketPriorityLabels, ticketStatusLabels } from '../types/tickets'
import type { CreateTicketResponse, TicketStatusInput, UpdateTicketDetailsInput } from '../types/tickets'
import type { CreateTicketCommentInput, CreateTicketInput, Ticket, TicketAssignmentInput, TicketAssignmentResponse, TicketDetails, TicketFilters, TicketReference, TicketsResponse } from '../types/tickets'
import { isValidTicketId } from '../utils/navigation'
import { parseTicketActivityDetails } from '../utils/ticket-history'

export async function updateTicketDetails(id: string, input: UpdateTicketDetailsInput): Promise<void> {
  const payload: UpdateTicketDetailsInput = {}
  if (input.category_id !== undefined) payload.category_id = input.category_id
  if (input.priority !== undefined) payload.priority = input.priority
  if (!isValidTicketId(id) || Object.keys(payload).length === 0 ||
    (payload.category_id !== undefined && (!Number.isSafeInteger(payload.category_id) || payload.category_id < 1)) ||
    (payload.priority !== undefined && !Object.hasOwn(ticketPriorityLabels, payload.priority))) {
    throw new Error('Informe um chamado e alterações válidas de categoria ou prioridade.')
  }
  const authenticationGeneration = await initializeCsrf()
  await apiRequest(`/tickets/${id}/details`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }, 200)
}

export function getTicketDetailsUpdateErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return 'Sua sessão expirou. Entre novamente para editar as informações.'
      case 403: return 'Você não tem permissão para editar as informações deste chamado ou sua conta está desativada.'
      case 404: return 'O chamado não existe ou não está disponível para sua conta.'
      case 409: return 'O chamado mudou ou não permite edição neste status. Atualize os detalhes antes de tentar novamente.'
      case 419: return 'Não foi possível validar sua sessão. Tente novamente; se o erro persistir, entre novamente.'
      case 422: return cause.validationErrors.payload?.join(' ') || 'Revise a categoria e a prioridade indicadas e tente novamente.'
    }
  }
  return 'Não foi possível confirmar a alteração. Suas seleções foram mantidas. Verifique sua conexão e atualize os detalhes antes de tentar novamente.'
}

export async function updateTicketStatus(id: string, input: TicketStatusInput): Promise<void> {
  if (!isValidTicketId(id) || !Object.hasOwn(ticketStatusLabels, input.status)) {
    throw new Error('Informe um chamado e um status válidos.')
  }
  const authenticationGeneration = await initializeCsrf()
  await apiRequest(`/tickets/${id}/status`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: input.status }),
  }, 200)
}

export function getTicketStatusErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return 'Sua sessão expirou. Entre novamente para alterar o status.'
      case 403: return 'Você não tem permissão para alterar o status deste chamado ou sua conta está desativada.'
      case 404: return 'O chamado não existe ou não está disponível para sua conta.'
      case 409: return 'Esta transição não é permitida ou o status mudou. Atualize os detalhes antes de tentar novamente.'
      case 419: return 'Não foi possível validar sua sessão. Tente novamente; se o erro persistir, entre novamente.'
      case 422: return cause.validationErrors.status?.join(' ') || cause.validationErrors.payload?.join(' ') || 'Selecione um status válido.'
    }
  }
  return 'Não foi possível confirmar a alteração. Sua seleção foi mantida. Verifique sua conexão e atualize os detalhes antes de tentar novamente.'
}

export async function updateTicketAssignment(id: string, input: TicketAssignmentInput): Promise<TicketAssignmentResponse> {
  if (!isValidTicketId(id) || (input.assigned_to !== null && (!Number.isSafeInteger(input.assigned_to) || input.assigned_to < 1))) {
    throw new Error('Informe um chamado e um responsável válidos.')
  }
  const authenticationGeneration = await initializeCsrf()
  const data = await apiRequest(`/tickets/${id}/assignment`, {
    authenticationGeneration, method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigned_to: input.assigned_to }),
  }, 200)
  if (!isRecord(data) || String(data.id) !== id || !Number.isInteger(data.id) ||
    !(data.assignee === null || isReference(data.assignee)) || !isDate(data.updated_at)) {
    throw new Error('A resposta de atribuição não possui o formato esperado. Atualize os detalhes antes de tentar novamente.')
  }
  const assignment = data as unknown as TicketAssignmentResponse
  if ((assignment.assignee?.id ?? null) !== input.assigned_to) throw new Error('A resposta não corresponde à atribuição solicitada.')
  return {
    id: assignment.id,
    assignee: assignment.assignee ? { id: assignment.assignee.id, name: assignment.assignee.name } : null,
    updated_at: assignment.updated_at,
  }
}

export function getTicketAssignmentErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return 'Sua sessão expirou. Entre novamente para alterar o responsável.'
      case 403: return 'Você não tem permissão para esta atribuição ou sua conta está desativada.'
      case 404: return 'O chamado não existe ou não está disponível para sua conta.'
      case 409: return 'A atribuição ou o status do chamado mudou. Atualize os detalhes antes de tentar novamente.'
      case 419: return 'Não foi possível validar sua sessão. Tente novamente; se o erro persistir, entre novamente.'
      case 422: return cause.validationErrors.assigned_to?.join(' ') || 'Selecione um técnico ativo válido.'
    }
  }
  return 'Não foi possível confirmar a alteração. Sua seleção foi mantida. Verifique sua conexão e atualize os detalhes antes de tentar novamente.'
}

export async function createTicketComment(id: string, input: CreateTicketCommentInput): Promise<void> {
  if (!isValidTicketId(id)) throw new Error('O identificador do chamado é inválido.')
  const authenticationGeneration = await initializeCsrf()
  await apiRequest(`/tickets/${id}/comments`, {
    authenticationGeneration, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: input.body.trim(), is_internal: input.is_internal }),
  }, 201)
}

export function getTicketCommentErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return 'Sua sessão expirou. Entre novamente para enviar a mensagem.'
      case 403: return 'Você não tem permissão para enviar este comentário ou sua conta está desativada.'
      case 404: return 'O chamado não existe ou não está disponível para sua conta.'
      case 409: return 'O chamado não aceita novos comentários no estado atual. Atualize a conversa para consultar o status.'
      case 419: return 'Não foi possível validar sua sessão. Tente novamente; se o erro persistir, entre novamente.'
      case 422: return 'Revise os campos indicados e tente novamente.'
    }
  }
  return 'Não foi possível confirmar o envio. Seu texto foi mantido. Verifique sua conexão e atualize a conversa antes de tentar novamente.'
}

export class TicketCreationResponseError extends Error {
  constructor() {
    super('O chamado foi criado, mas a API não retornou um identificador válido. Consulte a listagem para localizar o chamado.')
    this.name = 'TicketCreationResponseError'
  }
}

export async function createTicket(input: CreateTicketInput): Promise<CreateTicketResponse> {
  const authenticationGeneration = await initializeCsrf()
  // A projeção explícita impede o envio de atributos controlados pelo backend.
  const data = await apiRequest('/tickets', {
    authenticationGeneration, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title.trim(),
      description: input.description.trim(),
      category_id: input.category_id,
      priority: input.priority,
    }),
  }, 201)
  if (!isRecord(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
    throw new TicketCreationResponseError()
  }
  return { id: data.id }
}

export function getCreateTicketErrorMessage(cause: unknown): string {
  if (cause instanceof TicketCreationResponseError) return cause.message
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401:
        return 'Sua sessão expirou. Entre novamente para criar o chamado.'
      case 403:
        return 'Você não tem permissão para criar chamados. Entre em contato com o suporte.'
      case 419:
        return 'Não foi possível validar sua sessão. Tente novamente; se o erro persistir, entre novamente.'
      case 422:
        return 'Revise os campos indicados e tente novamente.'
      case 503:
        return 'A abertura de chamados está indisponível no momento. Seus dados foram mantidos; tente novamente mais tarde.'
      default:
        return 'Não foi possível confirmar a criação. Consulte a listagem antes de tentar novamente.'
    }
  }

  return 'Não foi possível confirmar a criação. Verifique sua conexão e consulte a listagem antes de tentar novamente.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isReference(value: unknown): value is TicketReference {
  return isRecord(value) && Number.isInteger(value.id) && typeof value.name === 'string'
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isNullableDate(value: unknown): boolean {
  return value === null || isDate(value)
}

function parseTicketDetails(data: unknown): TicketDetails {
  if (
    !isRecord(data) || !isTicket(data) || typeof data.description !== 'string' || !isDate(data.updated_at) ||
    !isNullableDate(data.first_responded_at) || !isNullableDate(data.resolved_at) || !isNullableDate(data.closed_at) ||
    !Array.isArray(data.comments) || !data.comments.every((comment: unknown) =>
      isRecord(comment) && Number.isInteger(comment.id) && isReference(comment.author) &&
      typeof comment.body === 'string' && isDate(comment.created_at) &&
      (!('is_internal' in comment) || typeof comment.is_internal === 'boolean')) ||
    !Array.isArray(data.activities) || !data.activities.every((activity: unknown) =>
      isRecord(activity) && Number.isInteger(activity.id) && typeof activity.action === 'string' &&
      (activity.actor === null || isReference(activity.actor)) && isDate(activity.created_at))
  ) {
    throw new Error('A resposta dos detalhes do chamado não possui o formato esperado.')
  }

  const ticket = data as unknown as TicketDetails
  const reference = ({ id, name }: TicketReference): TicketReference => ({ id, name })
  return {
    id: ticket.id, title: ticket.title, description: ticket.description, priority: ticket.priority,
    requester: reference(ticket.requester), assignee: ticket.assignee ? reference(ticket.assignee) : null,
    category: reference(ticket.category), status: { ...reference(ticket.status), code: ticket.status.code },
    created_at: ticket.created_at, updated_at: ticket.updated_at,
    first_response_due_at: ticket.first_response_due_at, resolution_due_at: ticket.resolution_due_at,
    first_responded_at: ticket.first_responded_at, resolved_at: ticket.resolved_at, closed_at: ticket.closed_at,
    comments: ticket.comments.map((comment) => ({
      id: comment.id, author: reference(comment.author), body: comment.body, created_at: comment.created_at,
      ...(comment.is_internal !== undefined ? { is_internal: comment.is_internal } : {}),
    })),
    activities: ticket.activities.map((activity) => {
      const details = parseTicketActivityDetails(activity.action, activity.details)
      return {
        id: activity.id, action: activity.action, actor: activity.actor ? reference(activity.actor) : null,
        created_at: activity.created_at,
        ...(details ? { details } : {}),
      }
    }),
  }
}

export async function getTicketDetails(id: string, signal?: AbortSignal): Promise<TicketDetails> {
  if (!isValidTicketId(id)) throw new Error('O identificador do chamado é inválido.')
  const ticket = parseTicketDetails(await apiRequest(`/tickets/${id}`, { signal }, 200))
  if (String(ticket.id) !== id) throw new Error('A resposta não corresponde ao chamado solicitado.')
  return ticket
}

export function getTicketDetailsErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401:
      case 419:
        return 'Sua sessão expirou. Entre novamente para consultar o chamado.'
      case 403:
        return 'Você não tem permissão para consultar chamados. Entre em contato com o suporte.'
      case 404:
        return 'O chamado não existe ou não está disponível para sua conta.'
      default:
        return 'Não foi possível carregar o chamado. Tente novamente mais tarde.'
    }
  }
  return 'Não foi possível carregar o chamado. Verifique sua conexão e tente novamente.'
}

function isTicket(value: unknown): value is Ticket {
  return isRecord(value) && Number.isInteger(value.id) &&
    typeof value.title === 'string' && typeof value.priority === 'string' &&
    Object.hasOwn(ticketPriorityLabels, value.priority) &&
    isReference(value.status) && 'code' in value.status && typeof value.status.code === 'string' &&
    isReference(value.category) && isReference(value.requester) &&
    (value.assignee === null || isReference(value.assignee)) &&
    isDate(value.created_at) && isDate(value.first_response_due_at) && isDate(value.resolution_due_at)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isPaginationNumber(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
}

function parseTickets(data: unknown): TicketsResponse {
  if (
    !isRecord(data) || !Array.isArray(data.data) || !data.data.every(isTicket) ||
    !isPaginationNumber(data.current_page, 1) || !isPaginationNumber(data.last_page, 1) ||
    !isPaginationNumber(data.per_page, 1) || !isPaginationNumber(data.total, 0) ||
    !(data.from === null || isPaginationNumber(data.from, 1)) ||
    !(data.to === null || isPaginationNumber(data.to, 1)) ||
    typeof data.first_page_url !== 'string' || typeof data.last_page_url !== 'string' ||
    !isNullableString(data.next_page_url) || !isNullableString(data.prev_page_url) ||
    typeof data.path !== 'string' || !Array.isArray(data.links) ||
    !data.links.every((link: unknown) => isRecord(link) && isNullableString(link.url) &&
      typeof link.label === 'string' && typeof link.active === 'boolean')
  ) {
    throw new Error('A resposta da listagem de chamados não possui o formato esperado.')
  }

  return data as unknown as TicketsResponse
}

export async function getTickets(filters: TicketFilters, signal?: AbortSignal): Promise<TicketsResponse> {
  const params = new URLSearchParams({ page: String(filters.page) })
  const search = filters.search.trim()
  if (search) params.set('search', search)
  if (filters.status) params.set('status', filters.status)
  if (filters.priority) params.set('priority', filters.priority)

  return parseTickets(await apiRequest(`/tickets?${params}`, { signal }))
}

export function getTicketsErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401:
      case 419:
        return 'Sua sessão expirou. Entre novamente para consultar os chamados.'
      case 403:
        return 'Você não tem permissão para consultar os chamados. Entre em contato com o suporte.'
      case 422:
        return Object.values(cause.validationErrors).flat().join(' ') || 'Verifique os filtros informados.'
      case 429:
        return 'Muitas consultas em pouco tempo. Aguarde um momento e tente novamente.'
      default:
        return 'Não foi possível carregar os chamados. Tente novamente mais tarde.'
    }
  }

  return 'Não foi possível carregar os chamados. Verifique sua conexão e tente novamente.'
}
