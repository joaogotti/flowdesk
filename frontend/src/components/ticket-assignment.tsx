import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { getTechnicians, getTechniciansErrorMessage } from '../services/technicians'
import { getTicketAssignmentErrorMessage, updateTicketAssignment } from '../services/tickets'
import type { AuthenticatedUser } from '../types/auth'
import type { Technician } from '../types/technicians'
import type { TicketReference } from '../types/tickets'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

interface Props {
  ticketId: string
  assignee: TicketReference | null
  status: string
  user: Pick<AuthenticatedUser, 'id' | 'role'>
  refreshing: boolean
  refreshError: string | null
  onUpdated: () => Promise<void>
}

export default function TicketAssignment({ ticketId, assignee, status, user, refreshing, refreshError, onUpdated }: Props) {
  const [editing, setEditing] = useState(false)
  const [technicians, setTechnicians] = useState<Technician[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selection, setSelection] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const loadController = useRef<AbortController | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const allowed = ['open', 'in_progress', 'waiting_requester'].includes(status)
  const busy = submitting || refreshing
  const stale = saved && refreshError !== null
  const isAdmin = user.role === 'admin'
  const canAct = allowed && (isAdmin || (user.role === 'technician' && assignee === null))
  const validSelection = technicians.some((technician) => String(technician.id) === selection)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; loadController.current?.abort() }
  }, [])

  useEffect(() => {
    if (editing && !loading) selectRef.current?.focus({ preventScroll: true })
  }, [editing, loading])

  async function loadTechnicians() {
    if (!isAdmin || !allowed) return
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setLoading(true)
    setLoadError(null)
    setTechnicians([])
    try {
      const data = await getTechnicians(controller.signal)
      if (!controller.signal.aborted) setTechnicians(data)
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(getTechniciansErrorMessage(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
      if (loadController.current === controller) loadController.current = null
    }
  }

  function openEditor() {
    if (!isAdmin || !canAct || busy || stale) return
    setSelection(assignee ? String(assignee.id) : '')
    setError(null)
    setEditing(true)
    void loadTechnicians()
  }

  function cancel() {
    if (busy || inProgress.current) return
    loadController.current?.abort()
    setEditing(false)
    setError(null)
    window.requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }))
  }

  async function save(assignedTo: number | null) {
    if (inProgress.current || busy || !canAct || stale) return
    if (!isAdmin && assignedTo !== user.id) return
    inProgress.current = true
    setSubmitting(true)
    setSaved(false)
    setError(null)
    try {
      await updateTicketAssignment(ticketId, { assigned_to: assignedTo })
    } catch (cause) {
      if (mounted.current) { setError(getTicketAssignmentErrorMessage(cause)); setSubmitting(false) }
      inProgress.current = false
      return
    }
    if (!mounted.current) { inProgress.current = false; return }
    setSaved(true)
    setEditing(false)
    loadController.current?.abort()
    // O PATCH já foi confirmado. A atualização dos detalhes é uma operação separada.
    try { await onUpdated() } finally {
      inProgress.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (validSelection && !loading && !loadError) void save(Number(selection))
  }

  return (
    <div>
      <p>{assignee?.name ?? 'Não atribuído'}</p>
      {saved && <p role="status" className="mt-2 text-xs leading-5 text-emerald-800">Atribuição salva com sucesso.</p>}
      {stale && <p role="alert" className="mt-2 text-xs leading-5 text-amber-800">A alteração foi salva, mas os detalhes não puderam ser atualizados. Atualize os detalhes para consultar o responsável atual.</p>}
      {error && <p id="assignment-error" role="alert" className="mt-2 text-xs leading-5 text-red-700">{error}</p>}
      {(stale || error) && <button type="button" disabled={busy} onClick={() => { void onUpdated() }} className={`${buttonClass} mt-3`}>Atualizar detalhes</button>}
      {submitting && <p role="status" className="mt-2 flex items-center gap-2 text-xs text-[#607189]"><span aria-hidden="true" className="size-3 rounded-full border-2 border-[#dce6f3] border-t-[#2864db] motion-safe:animate-spin" />{saved ? 'Atualizando detalhes...' : 'Salvando atribuição...'}</p>}
      {canAct && !stale && (isAdmin ? (
        editing ? (
          <form aria-label="Alterar responsável" aria-busy={busy || loading} onSubmit={handleSubmit} className="mt-3 space-y-3">
            {loading ? <p role="status" className="text-xs text-[#607189]">Carregando técnicos...</p> : loadError ? (
              <div><p role="alert" className="text-xs leading-5 text-red-700">{loadError}</p><button type="button" disabled={busy} onClick={() => { void loadTechnicians() }} className={`${buttonClass} mt-2`}>Tentar carregar técnicos</button></div>
            ) : technicians.length ? (
              <div>
                <label htmlFor="assignment-technician" className="mb-1 block text-xs font-medium text-[#3d526d]">Técnico responsável</label>
                <select ref={selectRef} id="assignment-technician" name="assigned_to" value={selection} onChange={(event) => setSelection(event.target.value)} disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'assignment-error' : undefined} className={`${fieldClass} min-w-0 text-xs`}>
                  <option value="" disabled>Selecione um técnico</option>
                  {technicians.map((technician) => <option key={technician.id} value={technician.id}>{technician.name}</option>)}
                </select>
              </div>
            ) : <p role="status" className="text-xs leading-5 text-[#607189]">Nenhum técnico ativo disponível para atribuição.</p>}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={busy || loading || !!loadError || !validSelection} className={`${primaryButtonClass} min-h-10 px-3 text-xs`}>Confirmar alteração</button>
              <button type="button" disabled={busy} onClick={cancel} className={buttonClass}>Cancelar</button>
            </div>
            {assignee && <button type="button" disabled={busy} onClick={() => { void save(null) }} className={`${buttonClass} text-red-700`}>Remover atribuição</button>}
          </form>
        ) : <button ref={editButtonRef} type="button" disabled={busy} onClick={openEditor} className={`${buttonClass} mt-3`}>Alterar responsável</button>
      ) : <button type="button" disabled={busy} onClick={() => { void save(user.id) }} className={`${buttonClass} mt-3`}>Assumir chamado</button>)}
    </div>
  )
}
