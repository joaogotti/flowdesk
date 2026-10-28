import { ticketPriorityLabels } from '../types/tickets'
import type { Ticket, TicketPriority } from '../types/tickets'

const priorityStyles: Record<TicketPriority, string> = {
  low: 'border-slate-200 bg-slate-50 text-slate-600',
  medium: 'border-blue-100 bg-blue-50 text-blue-700',
  high: 'border-amber-200 bg-amber-50 text-amber-800',
  urgent: 'border-red-200 bg-red-50 text-red-700',
}

export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  return <span className={`inline-flex rounded-md border px-2 py-1 text-[11px] font-medium ${priorityStyles[priority]}`}>{ticketPriorityLabels[priority]}</span>
}

export function TicketStatusBadge({ status }: { status: Pick<Ticket['status'], 'code' | 'name'> }) {
  return <span className="inline-flex rounded-md border border-[#dce6f3] bg-[#f2f6fc] px-2 py-1 text-[11px] font-medium text-[#3d5e8a]">{status.name}</span>
}
