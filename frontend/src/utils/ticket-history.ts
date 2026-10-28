import { ticketPriorityLabels, ticketStatusLabels } from '../types/tickets'
import type { TicketActivity, TicketActivityDetails, TicketActivityReference, TicketActivityTransition } from '../types/tickets'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReference(value: unknown): TicketActivityReference | undefined {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 ||
    (value.name !== undefined && value.name !== null && typeof value.name !== 'string')) return undefined
  return { id: value.id, name: typeof value.name === 'string' && value.name.trim() ? value.name : null }
}

function parseTransition<T>(value: unknown, parse: (value: unknown) => T | undefined): TicketActivityTransition<T> | undefined {
  if (!isRecord(value)) return undefined
  const transition: TicketActivityTransition<T> = {}
  for (const side of ['from', 'to'] as const) {
    if (!Object.hasOwn(value, side)) continue
    const parsed = value[side] === null ? null : parse(value[side])
    if (parsed !== undefined) transition[side] = parsed
  }
  return Object.keys(transition).length ? transition : undefined
}

export function parseTicketActivityDetails(action: string, value: unknown): TicketActivityDetails | undefined {
  if (!isRecord(value)) return undefined
  const details: TicketActivityDetails = {}
  if (action === 'assignment_changed') {
    const assignee = parseTransition(value.assignee, parseReference)
    if (assignee) details.assignee = assignee
  } else if (action === 'status_changed') {
    const status = parseTransition(value.status, (code) =>
      typeof code === 'string' && Object.hasOwn(ticketStatusLabels, code) ? code as keyof typeof ticketStatusLabels : undefined)
    if (status) details.status = status
  } else if (action === 'details_changed') {
    const category = parseTransition(value.category, parseReference)
    const priority = parseTransition(value.priority, (code) =>
      typeof code === 'string' && Object.hasOwn(ticketPriorityLabels, code) ? code as keyof typeof ticketPriorityLabels : undefined)
    if (category) details.category = category
    if (priority) details.priority = priority
  }
  return Object.keys(details).length ? details : undefined
}

function referenceLabel(value: TicketActivityReference | null | undefined, field: 'assignee' | 'category'): string {
  if (value === undefined) return 'Não informado'
  if (value === null) return field === 'assignee' ? 'Não atribuído' : 'Não informado'
  return value.name ?? `${field === 'assignee' ? 'Usuário' : 'Categoria'} #${value.id}`
}

export function getTicketActivityEntries(activity: TicketActivity): { title: string; transition?: string }[] {
  const details = activity.details
  if (activity.action === 'assignment_changed' && details?.assignee) {
    return [{ title: 'Responsável alterado', transition: `${referenceLabel(details.assignee.from, 'assignee')} → ${referenceLabel(details.assignee.to, 'assignee')}` }]
  }
  if (activity.action === 'status_changed' && details?.status) {
    const { from, to } = details.status
    return [{ title: 'Status alterado', transition: `${from ? ticketStatusLabels[from] : 'Não informado'} → ${to ? ticketStatusLabels[to] : 'Não informado'}` }]
  }
  if (activity.action === 'details_changed') {
    const entries: { title: string; transition?: string }[] = []
    if (details?.category) entries.push({ title: 'Categoria alterada', transition: `${referenceLabel(details.category.from, 'category')} → ${referenceLabel(details.category.to, 'category')}` })
    if (details?.priority) {
      const { from, to } = details.priority
      entries.push({ title: 'Prioridade alterada', transition: `${from ? ticketPriorityLabels[from] : 'Não informado'} → ${to ? ticketPriorityLabels[to] : 'Não informado'}` })
    }
    return entries.length ? entries : [{ title: 'Informações alteradas' }]
  }
  const labels: Record<string, string> = {
    created: 'Chamado criado', ticket_created: 'Chamado criado', comment_added: 'Comentário adicionado',
    assignment_changed: 'Responsável alterado', status_changed: 'Status alterado',
  }
  return [{ title: Object.hasOwn(labels, activity.action) ? labels[activity.action] : activity.action }]
}
