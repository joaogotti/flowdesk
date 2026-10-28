const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
})

export function formatTicketDate(value: string): string {
  return dateFormatter.format(new Date(value))
}

export type DeadlineState = 'pending' | 'overdue' | 'met' | 'late' | 'inactive' | 'unknown'

interface DeadlineInput {
  dueAt: string
  occurredAt: string | null
  createdAt: string
  closedAt: string | null
  resolvedAt: string | null
  status: string
  now: number
}

export function getDeadlineState({ dueAt, occurredAt, createdAt, closedAt, resolvedAt, status, now }: DeadlineInput): DeadlineState {
  const due = Date.parse(dueAt)
  const created = Date.parse(createdAt)
  const closed = closedAt === null ? null : Date.parse(closedAt)
  const resolved = resolvedAt === null ? null : Date.parse(resolvedAt)
  if (!Number.isFinite(now) || !Number.isFinite(due) || !Number.isFinite(created) || due < created || created > now ||
    (closed !== null && (!Number.isFinite(closed) || closed < created || closed > now)) ||
    (resolved !== null && (!Number.isFinite(resolved) || resolved < created || resolved > now || (closed !== null && resolved > closed)))) return 'unknown'

  if (occurredAt !== null) {
    const occurred = Date.parse(occurredAt)
    if (!Number.isFinite(occurred) || occurred < created || occurred > now || (closed !== null && occurred > closed) ||
      (resolved !== null && occurred > resolved)) return 'unknown'
    return occurred <= due ? 'met' : 'late'
  }
  // Encerramento não comprova quando houve resposta ou resolução.
  if (closed !== null || resolved !== null || ['resolved', 'closed', 'cancelled'].includes(status)) return 'inactive'
  // Não inferimos a semântica de futuros códigos de status do backend.
  if (!['open', 'in_progress', 'waiting_requester'].includes(status)) return 'unknown'
  return now > due ? 'overdue' : 'pending'
}
