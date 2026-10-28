import { useEffect, useState } from 'react'
import { buttonClass } from './control-styles'
import Icon from './icon'
import { TicketStatusBadge } from './ticket-badges'
import TicketDate from './ticket-date'
import { getRecentTickets, getRecentTicketsErrorMessage } from '../services/dashboard'
import type { RecentTicket } from '../types/dashboard'

interface RecentResult {
  attempt: number
  tickets: RecentTicket[] | null
  error: string | null
}

export default function DashboardRecentTickets() {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<RecentResult | null>(null)
  const isLoading = result?.attempt !== attempt
  const tickets = !isLoading ? result?.tickets : null
  const error = !isLoading ? result?.error : null

  useEffect(() => {
    const controller = new AbortController()
    // Evita consultas duplicadas na montagem do Strict Mode e cancela consultas obsoletas.
    const timer = window.setTimeout(() => {
      getRecentTickets(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ attempt, tickets: data, error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({ attempt, tickets: null, error: getRecentTicketsErrorMessage(cause) })
        })
    }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [attempt])

  return (
    <section aria-labelledby="recent-tickets-title" aria-busy={isLoading} className="min-w-0 overflow-hidden rounded-xl border border-[#e0e6ee] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
      <div className="flex items-center justify-between gap-3 px-5 py-5 sm:px-6">
        <div>
          <h2 id="recent-tickets-title" className="text-sm font-semibold text-[#263c57]">Chamados recentes</h2>
          <p className="mt-1 text-xs leading-5 text-[#607189]">Últimas atualizações dos chamados disponíveis para sua conta.</p>
        </div>
      </div>

      {isLoading && (
        <div role="status" className="flex items-center justify-center gap-3 border-t border-[#e9edf3] px-6 py-18 text-sm text-[#607189]">
          <span aria-hidden="true" className="size-4 shrink-0 rounded-full border-2 border-[#dce6f3] border-t-[#2864db] motion-safe:animate-spin" />
          Carregando chamados recentes...
        </div>
      )}

      {error && (
        <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 sm:m-6">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className={`${buttonClass} mt-3`}>Tentar novamente</button>
        </div>
      )}

      {tickets && (tickets.length === 0 ? (
        <div role="status" className="border-t border-[#e9edf3] px-6 py-18 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-[#e3eaf3] bg-[#f5f8fc] text-[#7892b3]"><Icon name="inbox" className="size-6" /></span>
          <p className="mt-5 text-sm font-medium text-[#3d526d]">Nenhum chamado encontrado.</p>
        </div>
      ) : (
        <table className="block w-full border-collapse text-left sm:table sm:table-fixed">
          <caption className="sr-only">Chamados recentes disponíveis para sua conta</caption>
          <thead className="sr-only border-y border-[#e9edf3] bg-[#fafbfd] text-[9px] tracking-[0.07em] text-[#607189] sm:not-sr-only sm:table-header-group">
            <tr>
              <th scope="col" className="px-6 py-3 font-medium sm:w-[35%]">CHAMADO</th>
              <th scope="col" className="px-3 py-3 font-medium sm:w-[20%]">STATUS</th>
              <th scope="col" className="px-3 py-3 font-medium sm:w-[23%]">RESPONSÁVEL</th>
              <th scope="col" className="px-6 py-3 text-right font-medium sm:w-[22%]">ATUALIZAÇÃO</th>
            </tr>
          </thead>
          <tbody className="block divide-y divide-[#e9edf3] sm:table-row-group">
            {tickets.map((ticket) => (
              <tr key={ticket.id} className="grid grid-cols-2 items-start gap-3 px-5 py-5 text-xs leading-5 text-[#3d526d] hover:bg-[#fafbfd] sm:table-row sm:p-0">
                <th scope="row" className="col-span-2 min-w-0 text-left text-[13px] font-medium wrap-anywhere sm:py-5 sm:pr-3 sm:pl-6">
                  <a href={`#/chamados/${ticket.id}`} aria-label={`Abrir chamado #${ticket.id}: ${ticket.title}`} className="rounded text-[#263c57] hover:text-[#2864db] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#2864db]">
                    <span className="mb-1 block text-[11px] font-semibold text-[#2864db]">#{ticket.id}</span>
                    {ticket.title}
                  </a>
                </th>
                <td className="min-w-0 wrap-anywhere sm:px-3 sm:py-5"><span aria-hidden="true" className="mb-1 block text-[10px] text-[#607189] sm:hidden">Status</span><TicketStatusBadge status={ticket.status} /></td>
                <td className="min-w-0 wrap-anywhere sm:px-3 sm:py-5"><span aria-hidden="true" className="mb-1 block text-[10px] text-[#607189] sm:hidden">Responsável</span>{ticket.assignee?.name ?? 'Não atribuído'}</td>
                <td className="col-span-2 min-w-0 wrap-anywhere text-[#607189] sm:py-5 sm:pr-6 sm:pl-3 sm:text-right"><span aria-hidden="true" className="mb-1 block text-[10px] sm:hidden">Atualização</span><TicketDate value={ticket.updated_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <div className="flex items-center gap-2 border-t border-[#e9edf3] bg-[#fafbfd] px-5 py-3.5 text-[10px] leading-5 text-[#607189] sm:px-6">
        <Icon name="shield" className="size-3.5 shrink-0" />
        Acesso aos chamados conforme as permissões da sua conta.
      </div>
    </section>
  )
}
