import type { AuthenticatedUser } from '../types/auth'
import type { Ticket, TicketPriority, UpdateTicketDetailsInput } from '../types/tickets'

export function canEditTicketDetails(user: Pick<AuthenticatedUser, 'id' | 'role'>, ticket: Pick<Ticket, 'status' | 'assignee'>): boolean {
  return ['open', 'in_progress', 'waiting_requester'].includes(ticket.status.code) &&
    (user.role === 'admin' || (user.role === 'technician' && ticket.assignee?.id === user.id))
}

export function getTicketDetailsChanges(original: { categoryId: number; priority: TicketPriority }, categoryId: number, priority: TicketPriority): UpdateTicketDetailsInput {
  return {
    ...(categoryId !== original.categoryId ? { category_id: categoryId } : {}),
    ...(priority !== original.priority ? { priority } : {}),
  }
}
