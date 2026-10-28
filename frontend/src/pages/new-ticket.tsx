import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { buttonClass, fieldClass, primaryButtonClass } from '../components/control-styles'
import Icon from '../components/icon'
import { ApiError } from '../services/api'
import { getCategories, getCategoriesErrorMessage } from '../services/categories'
import { createTicket, getCreateTicketErrorMessage, TicketCreationResponseError } from '../services/tickets'
import type { Category } from '../types/categories'
import { ticketPriorityLabels } from '../types/tickets'
import type { TicketPriority } from '../types/tickets'
import { ticketDescriptionMaxLength, ticketTitleMaxLength, validateTicketForm } from '../utils/ticket-form'
import type { TicketFormErrors, TicketFormValues } from '../utils/ticket-form'

interface CategoriesState {
  attempt: number
  data: Category[]
  error: string | null
}

function FieldError({ name, messages }: { name: string; messages?: string[] }) {
  return messages?.length ? <p id={`${name}-error`} role="alert" className="mt-2 text-xs leading-5 text-red-700">{messages.join(' ')}</p> : null
}

export default function NewTicket({ onCreated }: { onCreated: (ticketId: number) => void }) {
  const [values, setValues] = useState<TicketFormValues>({ title: '', description: '', category_id: '', priority: 'medium' })
  const [errors, setErrors] = useState<TicketFormErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [creationConfirmed, setCreationConfirmed] = useState(false)
  const [createdId, setCreatedId] = useState<number | null>(null)
  const submissionInProgress = useRef(false)
  const mounted = useRef(true)
  const formRef = useRef<HTMLFormElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const returnedErrorNeedsFocus = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const [categoriesState, setCategoriesState] = useState<CategoriesState | null>(null)
  const isLoadingCategories = categoriesState?.attempt !== attempt
  const categories = !isLoadingCategories ? categoriesState?.data ?? [] : []
  const categoriesError = !isLoadingCategories ? categoriesState?.error : null
  const categoriesAvailable = !isLoadingCategories && !categoriesError && categories.length > 0
  const labelClass = 'mb-2 block text-sm font-medium text-[#263c57]'

  useEffect(() => {
    mounted.current = true
    headingRef.current?.focus()
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (isSubmitting || !returnedErrorNeedsFocus.current) return
    returnedErrorNeedsFocus.current = false
    const first = Object.keys(errors)[0]
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus()
    else errorRef.current?.focus()
  }, [errors, error, isSubmitting])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getCategories(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setCategoriesState({ attempt, data: data.filter(category => Number.isSafeInteger(category.id) && category.id > 0), error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setCategoriesState({ attempt, data: [], error: getCategoriesErrorMessage(cause) })
        })
    }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [attempt])

  function updateField(name: keyof TicketFormValues, value: string) {
    setValues((current) => ({ ...current, [name]: value }))
    setErrors((current) => ({ ...current, [name]: undefined }))
  }

  function focusFirstError(nextErrors: TicketFormErrors) {
    const name = Object.keys(nextErrors)[0]
    formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus()
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submissionInProgress.current || creationConfirmed || !categoriesAvailable) return
    const nextErrors = validateTicketForm(values, categories)
    setErrors(nextErrors)
    setError(null)
    if (Object.keys(nextErrors).length) {
      focusFirstError(nextErrors)
      return
    }

    submissionInProgress.current = true
    setIsSubmitting(true)
    let created = false
    try {
      const ticket = await createTicket({
        title: values.title.trim(),
        description: values.description.trim(),
        category_id: Number(values.category_id),
        priority: values.priority as TicketPriority,
      })
      created = true
      if (mounted.current) {
        setCreationConfirmed(true)
        setCreatedId(ticket.id)
        setIsSubmitting(false)
        // Navegação separada do POST confirmado: uma falha nunca libera novo envio.
        try { onCreated(ticket.id) } catch {
          returnedErrorNeedsFocus.current = true
          setError('O chamado foi criado, mas não foi possível abrir os detalhes. Use o acesso abaixo para consultar o chamado.')
        }
      }
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof TicketCreationResponseError) {
        created = true
        setCreationConfirmed(true)
        setIsSubmitting(false)
        returnedErrorNeedsFocus.current = true
        setError(cause.message)
        return
      }
      const fieldErrors: TicketFormErrors = {}
      if (cause instanceof ApiError && cause.status === 422) {
        for (const name of ['title', 'description', 'category_id', 'priority'] as const) {
          if (cause.validationErrors[name]?.length) fieldErrors[name] = cause.validationErrors[name]
        }
      }
      setErrors(fieldErrors)
      returnedErrorNeedsFocus.current = true
      setError(getCreateTicketErrorMessage(cause))
    } finally {
      if (!created) {
        submissionInProgress.current = false
        if (mounted.current) setIsSubmitting(false)
      }
    }
  }

  return (
    <div className="max-w-240">
      <div className="mb-8">
        <p className="mb-2.5 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">CENTRAL DE ATENDIMENTO</p>
        <h1 tabIndex={-1} ref={headingRef} className="text-[28px] leading-tight font-semibold tracking-[-0.035em] text-[#172b45] outline-none sm:text-[32px]">Novo chamado</h1>
        <p className="mt-2.5 text-[13px] leading-6 text-[#607189]">Descreva sua solicitação para que a equipe possa ajudar.</p>
      </div>

      {creationConfirmed && <div role="status" className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">{createdId ? `Chamado #${createdId} criado com sucesso.` : 'Chamado criado com sucesso. Consulte a listagem para localizá-lo.'}</div>}

      <form ref={formRef} onSubmit={handleSubmit} noValidate aria-busy={isSubmitting} aria-labelledby="ticket-form-title" className="overflow-hidden rounded-xl border border-[#e0e6ee] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
        <div className="border-b border-[#e9edf3] px-5 py-5 sm:px-7">
          <h2 id="ticket-form-title" className="text-sm font-semibold text-[#263c57]">Informações do chamado</h2>
          <p className="mt-1 text-xs leading-5 text-[#607189]">Todos os campos são obrigatórios.</p>
        </div>
        <div className="space-y-6 p-5 sm:p-7">
          {error && <div ref={errorRef} role="alert" tabIndex={-1} className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800 outline-none focus-visible:outline-2 focus-visible:outline-red-700">{error}</div>}
          <fieldset disabled={isSubmitting || creationConfirmed} className="min-w-0 space-y-6">
            <legend className="sr-only">Dados obrigatórios do chamado</legend>
            <div>
              <label htmlFor="new-ticket-title" className={labelClass}>Título <span aria-hidden="true" className="text-[#607189]">*</span></label>
              <input id="new-ticket-title" name="title" required maxLength={ticketTitleMaxLength} value={values.title} onChange={(event) => updateField('title', event.target.value)} aria-invalid={Boolean(errors.title)} aria-describedby={`title-count${errors.title ? ' title-error' : ''}`} className={fieldClass} placeholder="Resuma o que você precisa" />
              <p id="title-count" className="mt-2 text-right text-[11px] text-[#607189]">{Array.from(values.title).length}/{ticketTitleMaxLength} caracteres</p>
              <FieldError name="title" messages={errors.title} />
            </div>
            <div>
              <label htmlFor="new-ticket-description" className={labelClass}>Descrição <span aria-hidden="true" className="text-[#607189]">*</span></label>
              <textarea id="new-ticket-description" name="description" required maxLength={ticketDescriptionMaxLength} rows={7} value={values.description} onChange={(event) => updateField('description', event.target.value)} aria-invalid={Boolean(errors.description)} aria-describedby={`description-hint description-count${errors.description ? ' description-error' : ''}`} className={`${fieldClass} resize-y py-3 leading-6`} placeholder="Explique o problema e o que aconteceu" />
              <p id="description-hint" className="mt-2 text-xs leading-5 text-[#607189]">Inclua o contexto e as informações necessárias para o atendimento.</p>
              <p id="description-count" className="mt-2 text-right text-[11px] text-[#607189]">{Array.from(values.description).length.toLocaleString('pt-BR')} / {ticketDescriptionMaxLength.toLocaleString('pt-BR')} caracteres</p>
              <FieldError name="description" messages={errors.description} />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <label htmlFor="new-ticket-category" className={labelClass}>Categoria <span aria-hidden="true" className="text-[#607189]">*</span></label>
                <select id="new-ticket-category" name="category_id" required disabled={!categoriesAvailable} value={values.category_id} onChange={(event) => updateField('category_id', event.target.value)} aria-invalid={Boolean(errors.category_id)} aria-describedby={`categories-message${errors.category_id ? ' category_id-error' : ''}`} className={fieldClass}>
                  <option value="">{isLoadingCategories ? 'Carregando categorias...' : categoriesAvailable ? 'Selecione a categoria' : 'Categorias indisponíveis'}</option>
                  {values.category_id && !categories.some(category => String(category.id) === values.category_id) && <option value={values.category_id} disabled>Categoria selecionada indisponível</option>}
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
                <div id="categories-message" className="mt-2 text-xs leading-5 text-[#607189]">
                  {isLoadingCategories ? <p role="status">Carregando categorias...</p> : categoriesError ? <p role="alert" className="text-red-700">{categoriesError}</p> : !categories.length ? <p role="status">Nenhuma categoria está disponível para abertura de chamados. Entre em contato com o suporte.</p> : <p>Selecione o assunto da solicitação.</p>}
                  {!isLoadingCategories && <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 rounded text-xs font-medium text-[#2864db] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2864db]">{categoriesAvailable ? 'Atualizar categorias' : 'Tentar novamente'}</button>}
                </div>
                <FieldError name="category_id" messages={errors.category_id} />
              </div>
              <div>
                <label htmlFor="new-ticket-priority" className={labelClass}>Prioridade <span aria-hidden="true" className="text-[#607189]">*</span></label>
                <select id="new-ticket-priority" name="priority" required value={values.priority} onChange={(event) => updateField('priority', event.target.value)} aria-invalid={Boolean(errors.priority)} aria-describedby={errors.priority ? 'priority-error' : undefined} className={fieldClass}>
                  {Object.entries(ticketPriorityLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
                <FieldError name="priority" messages={errors.priority} />
              </div>
            </div>
          </fieldset>
        </div>
        <div className="flex flex-wrap justify-end gap-3 border-t border-[#e9edf3] bg-[#fafbfd] px-5 py-5 sm:px-7">
          <button type="button" disabled={isSubmitting} onClick={() => { window.location.hash = '#/chamados' }} className={`${buttonClass} min-h-11 px-5 text-sm`}>{creationConfirmed ? 'Voltar aos chamados' : 'Cancelar'}</button>
          {creationConfirmed ? createdId !== null && <a href={`#/chamados/${createdId}`} className={primaryButtonClass}>Abrir chamado #{createdId}</a> : <button type="submit" disabled={isSubmitting || !categoriesAvailable} className={primaryButtonClass}>
            {isSubmitting ? <span aria-hidden="true" className="size-4 rounded-full border-2 border-white/40 border-t-white motion-safe:animate-spin" /> : <Icon name="ticket" className="size-4" />}
            {isSubmitting ? 'Criando chamado...' : 'Criar chamado'}
          </button>}
        </div>
        <p role="status" className="sr-only">{isSubmitting ? 'Enviando chamado. Aguarde a confirmação.' : ''}</p>
      </form>
    </div>
  )
}
