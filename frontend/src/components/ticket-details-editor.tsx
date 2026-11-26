import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError } from '../services/api'
import type { ValidationErrors } from '../services/api'
import { getCategories, getCategoriesErrorMessage } from '../services/categories'
import { getTicketDetailsUpdateErrorMessage, updateTicketDetails } from '../services/tickets'
import type { AuthenticatedUser } from '../types/auth'
import type { Category } from '../types/categories'
import { ticketPriorityLabels } from '../types/tickets'
import type { Ticket, TicketPriority } from '../types/tickets'
import { canEditTicketDetails, getTicketDetailsChanges } from '../utils/ticket-details'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

interface Props {
  ticketId: string
  ticket: Ticket
  user: Pick<AuthenticatedUser, 'id' | 'role'>
  refreshing: boolean
  refreshError: string | null
  onUpdated: () => Promise<boolean>
}

export default function TicketDetailsEditor({ ticketId, ticket, user, refreshing, refreshError, onUpdated }: Props) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [original, setOriginal] = useState({ categoryId: ticket.category.id, priority: ticket.priority })
  const [categoryId, setCategoryId] = useState(String(ticket.category.id))
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority)
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState<'patch' | 'refresh' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<ValidationErrors>({})
  const [saved, setSaved] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const loadController = useRef<AbortController | null>(null)
  const categoryRef = useRef<HTMLSelectElement>(null)
  const priorityRef = useRef<HTMLSelectElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const feedbackRef = useRef<HTMLDivElement>(null)
  const restoreFocusPending = useRef(false)
  const canAct = canEditTicketDetails(user, ticket)
  const busy = pending !== null || refreshing
  const changes = getTicketDetailsChanges(original, Number(categoryId), priority)
  const hasChanges = Object.keys(changes).length > 0
  const categoryAvailable = categories.some(category => String(category.id) === categoryId)
  const valid = Object.hasOwn(ticketPriorityLabels, priority) &&
    (changes.category_id === undefined || (categoryAvailable && !loadError))
  const changedElsewhere = editing && (ticket.category.id !== original.categoryId || ticket.priority !== original.priority)
  const categoryError = fieldErrors.category_id?.join(' ')
  const priorityError = fieldErrors.priority?.join(' ')

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; loadController.current?.abort() }
  }, [])

  useEffect(() => {
    if (editing && !loading) (categoryRef.current?.disabled ? priorityRef.current : categoryRef.current)?.focus({ preventScroll: true })
  }, [editing, loading])

  useLayoutEffect(() => {
    if (!restoreFocusPending.current || editing || busy) return
    restoreFocusPending.current = false
    const target = editRef.current ?? feedbackRef.current
    target?.focus({ preventScroll: true })
  }, [editing, busy])

  async function loadCategories() {
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const data = await getCategories(controller.signal)
      if (!controller.signal.aborted) setCategories(data.filter(category => Number.isSafeInteger(category.id) && category.id > 0))
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(getCategoriesErrorMessage(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
      if (loadController.current === controller) loadController.current = null
    }
  }

  function openEditor() {
    if (!canAct || busy || inProgress.current || needsRefresh) return
    setOriginal({ categoryId: ticket.category.id, priority: ticket.priority })
    setCategoryId(String(ticket.category.id))
    setPriority(ticket.priority)
    setCategories([])
    setError(null)
    setFieldErrors({})
    setSaved(false)
    setReviewRequired(false)
    setEditing(true)
    void loadCategories()
  }

  function cancel() {
    if (busy || inProgress.current) return
    loadController.current?.abort()
    restoreFocusPending.current = true
    setEditing(false)
    setError(null)
    setFieldErrors({})
  }

  async function refresh() {
    if (busy || inProgress.current) return
    inProgress.current = true
    setPending('refresh')
    try {
      const updated = await onUpdated()
      if (mounted.current && updated) {
        setNeedsRefresh(false)
        setReviewRequired(false)
        setError(null)
        setFieldErrors({})
      }
    } finally {
      inProgress.current = false
      if (mounted.current) setPending(null)
    }
  }

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canAct || busy || loading || inProgress.current || needsRefresh || reviewRequired || !hasChanges || !valid) return
    inProgress.current = true
    setPending('patch')
    setError(null)
    setFieldErrors({})
    try {
      await updateTicketDetails(ticketId, changes)
    } catch (cause) {
      inProgress.current = false
      if (mounted.current) {
        setPending(null)
        setError(getTicketDetailsUpdateErrorMessage(cause))
        if (cause instanceof ApiError) {
          if (cause.status === 422) setFieldErrors(cause.validationErrors)
          if ([403, 404, 409].includes(cause.status)) setReviewRequired(true)
        }
      }
      return
    }
    if (!mounted.current) { inProgress.current = false; return }
    setSaved(true)
    setNeedsRefresh(true)
    setEditing(false)
    setPending('refresh')
    loadController.current?.abort()
    // O PATCH já foi confirmado. Uma falha na consulta nunca reenvia a alteração.
    try {
      const updated = await onUpdated()
      if (mounted.current && updated) setNeedsRefresh(false)
    } finally {
      inProgress.current = false
      if (mounted.current) {
        restoreFocusPending.current = true
        setPending(null)
      }
    }
  }

  if (!canAct && !saved && !error) return null

  return (
    <div aria-label="Edição das informações do chamado" className="mt-5 border-t border-[#edf0f5] pt-4">
      <div ref={feedbackRef} tabIndex={-1} className="rounded outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#2864db]">
        {saved && <p role="status" className="text-xs leading-5 text-emerald-800">Informações salvas com sucesso.</p>}
        {saved && needsRefresh && pending === null && <p role="alert" className="mt-2 text-xs leading-5 text-amber-800">As informações foram salvas, mas os detalhes não puderam ser atualizados. Atualize os detalhes para consultar a categoria, a prioridade, o SLA e o histórico atuais.</p>}
      </div>
      {(needsRefresh || reviewRequired || error) && refreshError && <p role="alert" className="mt-2 text-xs leading-5 text-amber-800">{refreshError}</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-xs leading-5 text-red-700">{error}</p>}
      {(needsRefresh || error || reviewRequired) && <button type="button" disabled={busy} onClick={() => { void refresh() }} className={`${buttonClass} mt-3`}>Atualizar detalhes</button>}
      {pending && <p role="status" className="mt-2 text-xs text-[#607189]">{pending === 'patch' ? 'Salvando informações...' : 'Atualizando detalhes...'}</p>}
      {canAct && !needsRefresh && (editing ? (
        <form aria-label="Editar informações" aria-busy={busy || loading} onSubmit={save} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="space-y-3">
          {changedElsewhere && <p role="status" className="text-xs leading-5 text-amber-800">As informações do chamado foram atualizadas. Confira os valores atuais acima e revise suas seleções antes de salvar.</p>}
          <div>
            <label htmlFor={`${id}-category`} className="mb-1 block text-xs font-medium text-[#3d526d]">Categoria</label>
            <select ref={categoryRef} id={`${id}-category`} name="category_id" value={categoryId} disabled={busy || loading || !!loadError || !categories.length} onChange={(event) => { setCategoryId(event.target.value); setFieldErrors(value => ({ ...value, category_id: [] })) }} aria-invalid={!!categoryError} aria-describedby={`${id}-categories-help${categoryError ? ` ${id}-category-error` : ''}`} className={`${fieldClass} min-w-0 text-xs`}>
              {!categoryAvailable && <option value={categoryId} disabled>{Number(categoryId) === ticket.category.id ? ticket.category.name : 'Categoria selecionada'} (indisponível)</option>}
              {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
            <p id={`${id}-categories-help`} role={loadError ? 'alert' : 'status'} className={`mt-1 text-xs leading-5 ${loadError ? 'text-red-700' : 'text-[#607189]'}`}>
              {loading ? 'Carregando categorias...' : loadError || (!categories.length ? 'Nenhuma categoria ativa disponível. Você ainda pode alterar a prioridade.' : !categoryAvailable ? 'A categoria selecionada não está disponível. Escolha uma categoria ativa ou mantenha a categoria atual para alterar somente a prioridade.' : 'Selecione uma categoria ativa.')}
            </p>
            {categoryError && <p id={`${id}-category-error`} role="alert" className="mt-1 text-xs leading-5 text-red-700">{categoryError}</p>}
            {!loading && (loadError || !categories.length || categoryError || !categoryAvailable) && <button type="button" disabled={busy} onClick={() => { void loadCategories() }} className={`${buttonClass} mt-2`}>Recarregar categorias</button>}
          </div>
          <div>
            <label htmlFor={`${id}-priority`} className="mb-1 block text-xs font-medium text-[#3d526d]">Prioridade</label>
            <select ref={priorityRef} id={`${id}-priority`} name="priority" value={priority} disabled={busy} onChange={(event) => { setPriority(event.target.value as TicketPriority); setFieldErrors(value => ({ ...value, priority: [] })) }} aria-invalid={!!priorityError} aria-describedby={`${changes.priority ? `${id}-sla-help` : ''}${priorityError ? ` ${id}-priority-error` : ''}`.trim() || undefined} className={`${fieldClass} min-w-0 text-xs`}>
              {(Object.keys(ticketPriorityLabels) as TicketPriority[]).map(code => <option key={code} value={code}>{ticketPriorityLabels[code]}</option>)}
            </select>
            {changes.priority && <p id={`${id}-sla-help`} className="mt-1 text-xs leading-5 text-[#607189]">Alterar a prioridade recalcula os prazos de SLA desde a abertura do chamado.</p>}
            {priorityError && <p id={`${id}-priority-error`} role="alert" className="mt-1 text-xs leading-5 text-red-700">{priorityError}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || loading || reviewRequired || !hasChanges || !valid} className={`${primaryButtonClass} min-h-10 px-3 text-xs`}>Salvar alterações</button>
            <button type="button" disabled={busy} onClick={cancel} className={buttonClass}>Cancelar</button>
          </div>
        </form>
      ) : <button ref={editRef} type="button" disabled={busy} onClick={openEditor} className={`${buttonClass}${saved ? ' mt-3' : ''}`}>Editar informações</button>)}
    </div>
  )
}
