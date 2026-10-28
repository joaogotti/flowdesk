import type { TicketDetails } from '../types/tickets'
import { getDeadlineState } from '../utils/ticket-dates'
import type { DeadlineState } from '../utils/ticket-dates'
import TicketDate from './ticket-date'

const deadlineLabels: Record<DeadlineState, string> = {
  pending: 'Dentro do prazo', overdue: 'Prazo vencido', met: 'Realizado no prazo',
  late: 'Realizado após o prazo', inactive: 'Encerrado sem data efetiva', unknown: 'Estado do prazo indisponível',
}
const deadlineStyles: Record<DeadlineState, string> = {
  pending: 'border-blue-100 bg-blue-50 text-blue-700',
  overdue: 'border-red-200 bg-red-50 text-red-800',
  met: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  late: 'border-amber-200 bg-amber-50 text-amber-800',
  inactive: 'border-slate-200 bg-slate-50 text-slate-600',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
}

export default function TicketSla({ ticket, now }: { ticket: TicketDetails; now: number }) {
  const deadlines = [
    { label: 'Primeira resposta', dueAt: ticket.first_response_due_at, occurredAt: ticket.first_responded_at },
    { label: 'Resolução', dueAt: ticket.resolution_due_at, occurredAt: ticket.resolved_at },
  ]
  return (
    <section aria-labelledby="sla-title" className="rounded-xl border border-[#e0e6ee] bg-white p-5">
      <h2 id="sla-title" className="text-sm font-semibold text-[#263c57]">Prazos de atendimento</h2>
      <div className="mt-5 space-y-5">
        {deadlines.map((deadline) => {
          const state = getDeadlineState({ ...deadline, createdAt: ticket.created_at, closedAt: ticket.closed_at, resolvedAt: ticket.resolved_at, status: ticket.status.code, now })
          return (
            <div key={deadline.label}>
              <h3 className="text-xs font-medium text-[#3d526d]">{deadline.label}</h3>
              <p className="mt-2 text-xs text-[#607189]"><TicketDate value={deadline.dueAt} /></p>
              <p className={`mt-2 inline-flex rounded-md border px-2 py-1 text-[10px] font-medium ${deadlineStyles[state]}`}>{deadlineLabels[state]}</p>
              {deadline.occurredAt && <p className="mt-2 text-[11px] leading-5 text-[#607189]">Registrado em <TicketDate value={deadline.occurredAt} /></p>}
            </div>
          )
        })}
      </div>
      <p className="mt-5 border-t border-[#e9edf3] pt-4 text-[10px] leading-5 text-[#607189]">Horário de Brasília · America/Sao_Paulo</p>
    </section>
  )
}
