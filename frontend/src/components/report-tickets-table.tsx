import type { Ref } from 'react'
import type { ReportTickets } from '../types/reports'
import { reportSlaLabels } from '../types/reports'
import { ticketPriorityLabels } from '../types/tickets'
import { buttonClass } from './control-styles'
import TicketDate from './ticket-date'

export default function ReportTicketsTable({ response, loading, error, disabled, onPage, onRetry, headingRef }: {
  response: ReportTickets | null; loading: boolean; error: string | null; disabled: boolean
  onPage: (page: number) => void; onRetry: () => void; headingRef: Ref<HTMLHeadingElement>
}) {
  const date = (value: string | null) => value ? <TicketDate value={value} /> : <span aria-label="Não registrado">—</span>
  return <section aria-labelledby="report-table-title" className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white">
    <div className="p-5 sm:p-6"><h2 id="report-table-title" ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-[#263c57] outline-none">Chamados criados no período</h2><p className="mt-2 text-xs leading-6 text-[#607189]">Filtros adicionais aplicados somente a esta tabela e ao CSV. Datas exibidas no horário de Brasília.</p></div>
    {loading ? <p role="status" aria-busy="true" className="px-5 pb-6 text-sm text-[#607189]">Carregando chamados do relatório...</p>
      : error ? <div role="alert" className="px-5 pb-6 text-sm text-red-800"><p>{error}</p><button type="button" className={`${buttonClass} mt-3`} onClick={onRetry}>Tentar novamente</button></div>
        : response && <>
          {response.data.length === 0 ? <p role="status" className="px-5 pb-6 text-sm text-[#607189]">Nenhum chamado encontrado nesta seleção.</p> : <div role="region" aria-label="Tabela de chamados, role horizontalmente para ver todas as colunas" tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-[#2864db]">
            <table className="w-full min-w-420 text-left text-xs text-[#3d526d]">
              <caption className="sr-only">Chamados filtrados por data de criação, ordenados do mais recente para o mais antigo</caption>
              <thead className="border-y border-[#e9edf3] bg-[#f8fafc] text-[11px] text-[#607189]"><tr>{['Chamado', 'Solicitante', 'Responsável atual', 'Categoria', 'Prioridade', 'Status', 'Criação', 'Primeira resposta', 'Resolução', 'Fechamento', 'SLA primeira resposta', 'SLA resolução'].map(label => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}</tr></thead>
              <tbody className="divide-y divide-[#edf0f5]">{response.data.map(ticket => <tr key={ticket.id} className="align-top hover:bg-[#f8fafc]">
                <td className="max-w-64 px-4 py-4"><a href={`#/chamados/${ticket.id}`} className="font-medium wrap-anywhere text-[#2864db] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2864db]">#{ticket.id} · {ticket.title}</a></td>
                <td className="max-w-48 px-4 py-4 wrap-anywhere">{ticket.requester.name}</td><td className="max-w-48 px-4 py-4 wrap-anywhere">{ticket.assignee?.name ?? 'Sem responsável'}</td><td className="max-w-48 px-4 py-4 wrap-anywhere">{ticket.category.name}</td>
                <td className="px-4 py-4">{ticketPriorityLabels[ticket.priority as keyof typeof ticketPriorityLabels] ?? ticket.priority}</td><td className="px-4 py-4">{ticket.status.name}</td>
                <td className="px-4 py-4">{date(ticket.created_at)}</td><td className="px-4 py-4">{date(ticket.first_responded_at)}</td><td className="px-4 py-4">{date(ticket.resolved_at)}</td><td className="px-4 py-4">{date(ticket.closed_at)}</td>
                <td className="px-4 py-4">{reportSlaLabels[ticket.sla.first_response]}</td><td className="px-4 py-4">{reportSlaLabels[ticket.sla.resolution]}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e9edf3] p-5 text-xs text-[#607189]">
            <p role="status">{response.total.toLocaleString('pt-BR')} chamados · Página {response.current_page} de {response.last_page}</p>
            <nav aria-label="Paginação do relatório" className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || response.current_page <= 1} onClick={() => onPage(response.current_page - 1)}>Anterior</button><button type="button" className={buttonClass} disabled={disabled || response.current_page >= response.last_page} onClick={() => onPage(response.current_page + 1)}>Próxima</button></nav>
          </div>
        </>}
  </section>
}
