import { useEffect, useId, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { getTicketStatusErrorMessage, updateTicketStatus } from '../services/tickets'
import type { AuthenticatedUser } from '../types/auth'
import { ticketStatusLabels } from '../types/tickets'
import type { Ticket, TicketStatusCode } from '../types/tickets'
import { canUpdateTicketStatus, getTicketStatusTransitions } from '../utils/ticket-status'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'
import { TicketStatusBadge } from './ticket-badges'

interface Props {
  ticketId: string
  status: Ticket['status']
  assignee: Ticket['assignee']
  user: Pick<AuthenticatedUser, 'id' | 'role'>
  refreshing: boolean
  refreshError: string | null
  onUpdated: () => Promise<boolean>
}

export default function TicketStatusControl({ ticketId, status, assignee, user, refreshing, refreshError, onUpdated }: Props) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [selection, setSelection] = useState<TicketStatusCode | ''>('')
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const selectRef = useRef<HTMLSelectElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const options = getTicketStatusTransitions(status.code)
  const canAct = canUpdateTicketStatus(user, assignee) && options.length > 0
  const busy = submitting || refreshing
  const finalTransition = selection === 'cancelled' || selection === 'closed'
  const valid = selection !== '' && options.includes(selection) && (!finalTransition || confirmed)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (editing) selectRef.current?.focus({ preventScroll: true })
  }, [editing])

  function restoreFocus() {
    window.requestAnimationFrame(() => (editRef.current ?? statusRef.current)?.focus({ preventScroll: true }))
  }

  function cancel() {
    if (busy || inProgress.current) return
    setEditing(false)
    setError(null)
    restoreFocus()
  }

  async function refresh() {
    if (inProgress.current || busy) return
    inProgress.current = true
    setSubmitting(true)
    try {
      const updated = await onUpdated()
      if (mounted.current && updated) { setNeedsRefresh(false); setError(null) }
    } finally {
      inProgress.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || busy || needsRefresh || !canAct || !valid || !selection) return
    inProgress.current = true
    setSubmitting(true)
    setError(null)
    setSaved(false)
    try {
      await updateTicketStatus(ticketId, { status: selection })
    } catch (cause) {
      inProgress.current = false
      if (mounted.current) { setError(getTicketStatusErrorMessage(cause)); setSubmitting(false) }
      return
    }
    if (!mounted.current) { inProgress.current = false; return }
    setSaved(true)
    setNeedsRefresh(true)
    setEditing(false)
    // O PATCH foi confirmado. Uma falha no GET permite apenas consultar novamente.
    try {
      const updated = await onUpdated()
      if (mounted.current && updated) setNeedsRefresh(false)
    } finally {
      inProgress.current = false
      if (mounted.current) { setSubmitting(false); restoreFocus() }
    }
  }

  return (
    <div>
      <div ref={statusRef} tabIndex={-1} className="w-fit rounded outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#2864db]"><TicketStatusBadge status={status} /></div>
      {saved && <p role="status" className="mt-2 text-xs leading-5 text-emerald-800">Status alterado com sucesso.</p>}
      {saved && needsRefresh && !submitting && <p role="alert" className="mt-2 text-xs leading-5 text-amber-800">O status foi alterado, mas os detalhes não puderam ser atualizados. Atualize os detalhes para consultar o status, o histórico e os prazos atuais.</p>}
      {needsRefresh && refreshError && <p className="mt-2 text-xs leading-5 text-amber-800">{refreshError}</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-xs leading-5 text-red-700">{error}</p>}
      {(needsRefresh || error) && <button type="button" disabled={busy} onClick={() => { void refresh() }} className={`${buttonClass} mt-3`}>Atualizar detalhes</button>}
      {submitting && <p role="status" className="mt-2 text-xs text-[#607189]">{saved || refreshing ? 'Atualizando detalhes...' : 'Salvando status...'}</p>}
      {canAct && !needsRefresh && (editing ? (
        <form aria-label="Alterar status" aria-busy={busy} onSubmit={save} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-3 space-y-3">
          <div>
            <label htmlFor={`${id}-status`} className="mb-1 block text-xs font-medium text-[#3d526d]">Novo status</label>
            <select ref={selectRef} id={`${id}-status`} name="status" value={selection} onChange={(event) => { setSelection(event.target.value as TicketStatusCode); setConfirmed(false); setError(null) }} disabled={busy} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} className={`${fieldClass} min-w-0 text-xs`}>
              <option value="" disabled>Selecione um status</option>
              {options.map((code) => <option key={code} value={code}>{ticketStatusLabels[code]}</option>)}
            </select>
          </div>
          {finalTransition && <label className="flex items-start gap-2 text-xs leading-5 text-[#3d526d]">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} className="mt-1 size-4 shrink-0 accent-[#2864db]" />
            <span>Confirmo que desejo {selection === 'cancelled' ? 'cancelar' : 'fechar'} este chamado. Não será possível reabri-lo.</span>
          </label>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !valid} className={`${primaryButtonClass} min-h-10 px-3 text-xs`}>Confirmar alteração de status</button>
            <button type="button" disabled={busy} onClick={cancel} className={buttonClass}>Cancelar</button>
          </div>
        </form>
      ) : <button ref={editRef} type="button" disabled={busy} onClick={() => { setEditing(true); setSelection(''); setConfirmed(false); setError(null) }} className={`${buttonClass} mt-3`}>Alterar status</button>)}
    </div>
  )
}
