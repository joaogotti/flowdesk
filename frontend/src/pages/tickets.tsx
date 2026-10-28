import { useEffect, useState } from 'react'
import Icon from '../components/icon'
import { buttonClass, fieldClass, primaryButtonClass } from '../components/control-styles'
import { TicketPriorityBadge, TicketStatusBadge } from '../components/ticket-badges'
import TicketDate from '../components/ticket-date'
import { getTickets, getTicketsErrorMessage } from '../services/tickets'
import { ticketPriorityLabels, ticketStatusLabels } from '../types/tickets'
import type { TicketFilters, TicketPriority, TicketStatusCode, TicketsResponse } from '../types/tickets'

const initialFilters: TicketFilters = { search: '', status: '', priority: '', page: 1 }
const ticketLinkClass = 'rounded hover:text-[#2864db] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#2864db]'

interface ListResult {
  key: string
  response: TicketsResponse | null
  error: string | null
}

export default function Tickets({ successMessage, onDismissSuccess }: { successMessage: string | null; onDismissSuccess: () => void }) {
  const [filters, setFilters] = useState<TicketFilters>(initialFilters)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<ListResult | null>(null)
  const requestKey = JSON.stringify([filters, attempt])
  const isLoading = result?.key !== requestKey
  const response = !isLoading ? result?.response : null
  const error = !isLoading ? result?.error : null
  const hasFilters = Boolean(filters.search.trim() || filters.status || filters.priority)

  useEffect(() => {
    const controller = new AbortController()
    // Cancela o temporizador e a consulta anterior quando os filtros mudam.
    // O pequeno atraso também evita consultas duplicadas no Strict Mode.
    const timer = window.setTimeout(() => {
      getTickets(filters, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ key: requestKey, response: data, error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({ key: requestKey, response: null, error: getTicketsErrorMessage(cause) })
        })
    }, filters.search.trim() ? 400 : 0)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [filters, requestKey])

  function updateFilters(update: Partial<TicketFilters>) {
    setFilters((current) => ({ ...current, ...update, page: 1 }))
  }

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
        <p className="mb-2.5 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">CENTRAL DE ATENDIMENTO</p>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.035em] text-[#172b45] sm:text-[32px]">Chamados</h1>
        <p className="mt-2.5 text-[13px] leading-6 text-[#607189]">Consulte suas solicitações e acompanhe o atendimento.</p>
        </div>
        <a href="#/chamados/novo" className={primaryButtonClass}><Icon name="ticket" className="size-4" />Novo chamado</a>
      </div>

      {successMessage && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <p role="status" className="flex items-center gap-2"><Icon name="check" className="size-4 shrink-0" />{successMessage}</p>
          <button type="button" onClick={onDismissSuccess} aria-label="Dispensar confirmação" className="flex size-8 shrink-0 items-center justify-center rounded hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-emerald-700"><Icon name="close" className="size-4" /></button>
        </div>
      )}

      <section aria-label="Filtros de chamados" className="mb-6 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
        <div className="grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="sm:col-span-2 xl:col-span-1">
            <label htmlFor="ticket-search" className="mb-2 block text-xs font-medium text-[#3d526d]">Pesquisar chamados</label>
            <input id="ticket-search" type="search" maxLength={255} value={filters.search} onChange={(event) => updateFilters({ search: event.target.value })} placeholder="Pesquisar por título ou descrição" className={fieldClass} />
          </div>
          <div>
            <label htmlFor="ticket-status" className="mb-2 block text-xs font-medium text-[#3d526d]">Status</label>
            <select id="ticket-status" value={filters.status} onChange={(event) => updateFilters({ status: event.target.value as TicketStatusCode | '' })} className={fieldClass}>
              <option value="">Todos os status</option>
              {Object.entries(ticketStatusLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ticket-priority" className="mb-2 block text-xs font-medium text-[#3d526d]">Prioridade</label>
            <select id="ticket-priority" value={filters.priority} onChange={(event) => updateFilters({ priority: event.target.value as TicketPriority | '' })} className={fieldClass}>
              <option value="">Todas as prioridades</option>
              {Object.entries(ticketPriorityLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </div>
          <button type="button" onClick={() => setFilters(initialFilters)} disabled={!hasFilters} className={`${buttonClass} min-h-11`}>Limpar filtros</button>
        </div>
      </section>

      <section aria-labelledby="tickets-title" aria-busy={isLoading} className="min-w-0 overflow-hidden rounded-xl border border-[#e0e6ee] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-6">
          <div>
            <h2 id="tickets-title" className="text-sm font-semibold text-[#263c57]">Lista de chamados</h2>
            <p className="mt-1 text-xs leading-5 text-[#607189]">Do mais recente para o mais antigo.</p>
          </div>
          <button type="button" disabled={isLoading} onClick={() => setAttempt((value) => value + 1)} className={buttonClass}>Atualizar lista</button>
        </div>

        {isLoading && (
          <div role="status" className="flex items-center justify-center gap-3 border-t border-[#e9edf3] px-6 py-20 text-sm text-[#607189]">
            <span aria-hidden="true" className="size-5 rounded-full border-2 border-[#dce6f3] border-t-[#2864db] motion-safe:animate-spin" />
            Carregando chamados...
          </div>
        )}

        {error && (
          <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800 sm:m-6">
            <p className="font-semibold">Não foi possível exibir os chamados</p>
            <p className="mt-2 leading-6">{error}</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)} className={`${buttonClass} mt-4`}>Tentar novamente</button>
          </div>
        )}

        {response && (
          <>
            {response.data.length > 0 ? (
              <div role="region" aria-label="Tabela de chamados, role horizontalmente para ver todas as colunas" tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2864db]">
                <table className="w-full min-w-240 border-collapse text-left text-xs">
                  <caption className="sr-only">Chamados disponíveis para sua conta</caption>
                  <thead className="border-y border-[#e9edf3] bg-[#fafbfd] text-[10px] tracking-[0.04em] text-[#607189]">
                    <tr>{['NÚMERO', 'TÍTULO', 'CATEGORIA', 'PRIORIDADE', 'STATUS', 'RESPONSÁVEL', 'CRIAÇÃO'].map((heading) => <th key={heading} scope="col" className="px-4 py-3.5 font-medium first:pl-6 last:pr-6">{heading}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[#edf0f5]">
                    {response.data.map((ticket) => (
                      <tr key={ticket.id} className="text-[#3d526d] hover:bg-[#fafbfd]">
                        <th scope="row" className="py-5 pr-4 pl-6 font-semibold whitespace-nowrap text-[#2864db]"><a href={`#/chamados/${ticket.id}`} aria-label={`Abrir chamado #${ticket.id}`} className={ticketLinkClass}>#{ticket.id}</a></th>
                        <td className="min-w-52 max-w-96 px-4 py-5 text-[13px] leading-6 font-medium wrap-anywhere text-[#263c57]"><a href={`#/chamados/${ticket.id}`} className={ticketLinkClass}>{ticket.title}</a></td>
                        <td className="max-w-48 px-4 py-5 wrap-anywhere">{ticket.category.name}</td>
                        <td className="px-4 py-5"><TicketPriorityBadge priority={ticket.priority} /></td>
                        <td className="px-4 py-5"><TicketStatusBadge status={ticket.status} /></td>
                        <td className="max-w-48 px-4 py-5 wrap-anywhere">{ticket.assignee?.name ?? 'Não atribuído'}</td>
                        <td className="py-5 pr-6 pl-4 whitespace-nowrap text-[#607189]"><TicketDate value={ticket.created_at} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div role="status" className="border-t border-[#e9edf3] px-6 py-18 text-center">
                <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-[#e3eaf3] bg-[#f5f8fc] text-[#7892b3]"><Icon name="inbox" className="size-6" /></span>
                <p className="mt-5 text-sm font-medium text-[#3d526d]">{response.total > 0 ? 'Não há chamados nesta página' : hasFilters ? 'Nenhum chamado encontrado' : 'Nenhum chamado disponível'}</p>
                <p className="mt-2 text-xs leading-6 text-[#607189]">{hasFilters ? 'Altere os filtros para consultar outros resultados.' : 'Os chamados disponíveis para sua conta aparecerão aqui.'}</p>
                {response.current_page > 1 && <button type="button" className={`${buttonClass} mt-4`} onClick={() => setFilters((current) => ({ ...current, page: 1 }))}>Voltar à primeira página</button>}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#e9edf3] bg-[#fafbfd] px-5 py-4 sm:px-6">
              <p role="status" className="text-xs text-[#607189]">{response.from !== null && response.to !== null ? `${response.from}–${response.to} de ${response.total} chamados` : `${response.total} chamados`}</p>
              <nav aria-label="Paginação de chamados" className="flex flex-wrap items-center gap-3">
                <button type="button" className={buttonClass} disabled={response.prev_page_url === null} onClick={() => setFilters((current) => ({ ...current, page: response.current_page - 1 }))}>Anterior</button>
                <span className="text-xs text-[#607189]">Página {response.current_page} de {response.last_page}</span>
                <button type="button" className={buttonClass} disabled={response.next_page_url === null} onClick={() => setFilters((current) => ({ ...current, page: response.current_page + 1 }))}>Próxima</button>
              </nav>
            </div>
          </>
        )}
      </section>
    </>
  )
}
