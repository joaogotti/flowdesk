import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { buttonClass } from '../components/control-styles'
import Icon from '../components/icon'
import { TicketPriorityBadge, TicketStatusBadge } from '../components/ticket-badges'
import TicketConversation from '../components/ticket-conversation'
import TicketCommentForm from '../components/ticket-comment-form'
import type { AuthenticatedUser } from '../types/auth'
import TicketAssignment from '../components/ticket-assignment'
import TicketAttachments from '../components/ticket-attachments'
import TicketDate from '../components/ticket-date'
import TicketDetailsEditor from '../components/ticket-details-editor'
import TicketHistory from '../components/ticket-history'
import TicketSla from '../components/ticket-sla'
import TicketStatusControl from '../components/ticket-status-control'
import { ApiError } from '../services/api'
import { getTicketDetails, getTicketDetailsErrorMessage } from '../services/tickets'
import type { TicketDetails as TicketDetailsData } from '../types/tickets'

interface DetailsResult {
  key: string
  ticket: TicketDetailsData | null
  error: string | null
  notFound: boolean
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="py-3.5 first:pt-0 last:pb-0"><dt className="text-[11px] text-[#607189]">{label}</dt><dd className="mt-1.5 text-xs leading-6 wrap-anywhere text-[#263c57]">{children}</dd></div>
}

export default function TicketDetails({ ticketId, user }: { ticketId: string | null; user: Pick<AuthenticatedUser, 'id' | 'role'> }) {
  const role = user.role
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<DetailsResult | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const refreshController = useRef<AbortController | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [attachmentsDenied, setAttachmentsDenied] = useState(false)
  const requestKey = `${ticketId}:${attempt}`
  const current = result?.key === requestKey ? result : null
  const hasResult = current !== null
  const isLoading = ticketId !== null && current === null
  const ticket = current?.ticket

  useEffect(() => () => { refreshController.current?.abort() }, [])

  async function refreshDetails(): Promise<boolean> {
    if (ticketId === null) return false
    // A atualização mais recente deve refletir todas as operações já confirmadas.
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    setRefreshing(true)
    setRefreshError(null)
    try {
      const data = await getTicketDetails(ticketId, controller.signal)
      if (!controller.signal.aborted) {
        setResult({ key: requestKey, ticket: data, error: null, notFound: false })
        setAttachmentsDenied(false)
        setNow(Date.now())
        return true
      }
      return false
    } catch (cause) {
      if (!controller.signal.aborted) {
        setRefreshError(getTicketDetailsErrorMessage(cause))
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setAttachmentsDenied(true)
        }
      }
      return false
    } finally {
      if (refreshController.current === controller) {
        if (!controller.signal.aborted) setRefreshing(false)
        refreshController.current = null
      }
    }
  }

  async function refreshConversation(): Promise<void> {
    await refreshDetails()
  }

  useEffect(() => {
    if (ticketId === null) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getTicketDetails(ticketId, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ key: requestKey, ticket: data, error: null, notFound: false })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({
            key: requestKey, ticket: null, error: getTicketDetailsErrorMessage(cause),
            notFound: cause instanceof ApiError && cause.status === 404,
          })
        })
    }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [ticketId, requestKey])

  useEffect(() => {
    headingRef.current?.focus()
  }, [requestKey, hasResult])

  useEffect(() => {
    const refreshClock = () => setNow(Date.now())
    const timer = window.setInterval(refreshClock, 30_000)
    window.addEventListener('focus', refreshClock)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshClock) }
  }, [])

  return (
    <>
      <div className="mb-7">
        <a href="#/chamados" className={`${buttonClass} mb-6 gap-2`}><span className="rotate-180"><Icon name="arrow" className="size-4" /></span>Voltar aos chamados</a>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-240">
            <p className="mb-2 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">{ticketId ? `CHAMADO #${ticketId}` : 'DETALHES DO CHAMADO'}</p>
            <h1 ref={headingRef} tabIndex={-1} className="text-[26px] leading-tight font-semibold tracking-[-0.035em] wrap-anywhere text-[#172b45] outline-none sm:text-[30px]">
              {ticket?.title ?? (ticketId === null ? 'Endereço de chamado inválido' : current?.notFound ? 'Chamado não encontrado' : 'Detalhes do chamado')}
            </h1>
          </div>
          {ticket && <div className="flex flex-wrap items-center gap-2"><TicketStatusBadge status={ticket.status} /><TicketPriorityBadge priority={ticket.priority} /></div>}
        </div>
      </div>

      {ticketId === null ? (
        <div role="alert" className="rounded-xl border border-[#e0e6ee] bg-white p-6 text-sm leading-7 text-[#607189]">Verifique o endereço ou escolha um chamado na listagem.</div>
      ) : isLoading ? (
        <div role="status" aria-busy="true" className="flex min-h-72 items-center justify-center gap-3 rounded-xl border border-[#e0e6ee] bg-white p-6 text-sm text-[#607189]">
          <span aria-hidden="true" className="size-5 rounded-full border-2 border-[#dce6f3] border-t-[#2864db] motion-safe:animate-spin" />Carregando chamado...
        </div>
      ) : current?.error ? (
        <div role="alert" className={`rounded-xl border p-6 text-sm leading-7 ${current.notFound ? 'border-[#e0e6ee] bg-white text-[#607189]' : 'border-red-200 bg-red-50 text-red-800'}`}>
          <p>{current.error}</p>
          {!current.notFound && <button type="button" onClick={() => setAttempt((value) => value + 1)} className={`${buttonClass} mt-4`}>Tentar novamente</button>}
        </div>
      ) : ticket && (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-6">
            <section aria-labelledby="description-title" className="rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
              <h2 id="description-title" className="text-sm font-semibold text-[#263c57]">Descrição do problema</h2>
              <p className="mt-4 text-sm leading-7 whitespace-pre-wrap wrap-anywhere text-[#3d526d]">{ticket.description}</p>
            </section>
            {!attachmentsDenied && <TicketAttachments key={`${ticketId}:${user.id}:${user.role}`} ticketId={ticketId} status={ticket.status.code} onCreated={refreshConversation} />}
            <TicketConversation comments={ticket.comments}>
              <TicketCommentForm ticketId={ticketId} status={ticket.status.code} role={role} refreshing={refreshing} refreshError={refreshError} onCreated={refreshConversation} />
            </TicketConversation>
            <TicketHistory activities={ticket.activities} />
          </div>
          <aside aria-label="Informações do chamado" className="min-w-0 space-y-5">
            <section aria-labelledby="ticket-info-title" className="rounded-xl border border-[#e0e6ee] bg-white p-5">
              <h2 id="ticket-info-title" className="mb-5 text-sm font-semibold text-[#263c57]">Informações do chamado</h2>
              <dl className="divide-y divide-[#edf0f5]">
                <InfoRow label="Solicitante">{ticket.requester.name}</InfoRow>
                <InfoRow label="Técnico responsável"><TicketAssignment ticketId={ticketId} assignee={ticket.assignee} status={ticket.status.code} user={user} refreshing={refreshing} refreshError={refreshError} onUpdated={refreshConversation} /></InfoRow>
                <InfoRow label="Categoria">{ticket.category.name}</InfoRow>
                <InfoRow label="Status"><TicketStatusControl key={`${ticketId}:${user.id}:${user.role}`} ticketId={ticketId} status={ticket.status} assignee={ticket.assignee} user={user} refreshing={refreshing} refreshError={refreshError} onUpdated={refreshDetails} /></InfoRow>
                <InfoRow label="Prioridade"><TicketPriorityBadge priority={ticket.priority} /></InfoRow>
                <InfoRow label="Data de abertura"><TicketDate value={ticket.created_at} /></InfoRow>
                <InfoRow label="Última atualização"><TicketDate value={ticket.updated_at} /></InfoRow>
                {ticket.first_responded_at && <InfoRow label="Primeira resposta registrada"><TicketDate value={ticket.first_responded_at} /></InfoRow>}
                {ticket.resolved_at && <InfoRow label="Resolução registrada"><TicketDate value={ticket.resolved_at} /></InfoRow>}
                {ticket.closed_at && <InfoRow label="Fechamento registrado"><TicketDate value={ticket.closed_at} /></InfoRow>}
              </dl>
              <TicketDetailsEditor key={`${ticketId}:${user.id}:${user.role}`} ticketId={ticketId} ticket={ticket} user={user} refreshing={refreshing} refreshError={refreshError} onUpdated={refreshDetails} />
            </section>
            <TicketSla ticket={ticket} now={now} />
          </aside>
        </div>
      )}
    </>
  )
}
