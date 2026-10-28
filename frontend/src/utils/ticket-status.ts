import type { AuthenticatedUser } from '../types/auth'
import type { Ticket, TicketStatusCode } from '../types/tickets'

const transitions: Record<TicketStatusCode, readonly TicketStatusCode[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['waiting_requester', 'resolved', 'cancelled'],
  waiting_requester: ['in_progress', 'cancelled'],
  resolved: ['in_progress', 'closed'],
  closed: [],
  cancelled: [],
}

export function getTicketStatusTransitions(status: string): readonly TicketStatusCode[] {
  return Object.hasOwn(transitions, status) ? transitions[status as TicketStatusCode] : []
}

export function canUpdateTicketStatus(user: Pick<AuthenticatedUser, 'id' | 'role'>, assignee: Ticket['assignee']): boolean {
  return user.role === 'admin' || (user.role === 'technician' && assignee?.id === user.id)
}
