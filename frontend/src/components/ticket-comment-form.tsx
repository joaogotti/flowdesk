import { useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError } from '../services/api'
import { createTicketComment, getTicketCommentErrorMessage } from '../services/tickets'
import type { UserRole } from '../types/auth'
import { canCommentOnTicket, commentMaxLength, validateTicketComment } from '../utils/ticket-comment'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

interface Props {
  ticketId: string
  status: string
  role: UserRole
  refreshing: boolean
  refreshError: string | null
  onCreated: () => Promise<void>
}

export default function TicketCommentForm({ ticketId, status, role, refreshing, refreshError, onCreated }: Props) {
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [internalError, setInternalError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const inProgress = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStaff = role === 'technician' || role === 'admin'
  const allowed = canCommentOnTicket(status)
  const busy = submitting || refreshing

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || busy || !allowed) return
    const validation = validateTicketComment(body)
    setBodyError(validation)
    if (validation) { textareaRef.current?.focus(); return }

    inProgress.current = true
    setSubmitting(true)
    setError(null)
    setInternalError(null)
    setSent(false)
    try {
      await createTicketComment(ticketId, { body: body.trim(), is_internal: isStaff && internal })
    } catch (cause) {
      setError(getTicketCommentErrorMessage(cause))
      if (cause instanceof ApiError && cause.status === 422) {
        setBodyError(cause.validationErrors.body?.join(' ') ?? null)
        setInternalError(cause.validationErrors.is_internal?.join(' ') ?? null)
      }
      inProgress.current = false
      setSubmitting(false)
      return
    }

    // O POST já foi confirmado. Uma falha no GET nunca é tratada como falha de envio.
    setBody('')
    setInternal(false)
    setSent(true)
    setSubmitting(false)
    try { await onCreated() } finally { inProgress.current = false }
  }

  return (
    <div className="border-t border-[#e9edf3] p-5 sm:p-6">
      {sent && <p role="status" className="mb-4 text-sm text-emerald-800">Mensagem enviada com sucesso.</p>}
      {refreshError && <p role="alert" className="mb-3 text-sm leading-6 text-amber-800">A conversa não pôde ser atualizada. {refreshError} A atualização não reenvia mensagens.</p>}
      {refreshing && <p role="status" className="mb-3 text-xs text-[#607189]">Atualizando conversa...</p>}
      <button type="button" disabled={busy} onClick={() => { void onCreated() }} className={`${buttonClass} mb-5`}>Atualizar conversa</button>
      {!allowed ? (
        <p className="text-sm leading-6 text-[#607189]">Este chamado não aceita novos comentários no estado atual.</p>
      ) : (
        <form onSubmit={handleSubmit} noValidate aria-label="Enviar comentário" aria-busy={busy}>
          <label htmlFor="comment-body" className="text-sm font-medium text-[#263c57]">Mensagem <span className="text-[#607189]">(obrigatória)</span></label>
          <textarea ref={textareaRef} id="comment-body" name="body" rows={3} required maxLength={commentMaxLength}
            value={body} onChange={(event) => { setBody(event.target.value); setBodyError(null) }} disabled={busy}
            aria-invalid={!!bodyError} aria-describedby={`comment-count${bodyError ? ' comment-body-error' : ''}`}
            className={`${fieldClass} mt-2 resize-y py-3 leading-6`} />
          <p id="comment-count" className="mt-1 text-right text-[11px] text-[#607189]">{body.length.toLocaleString('pt-BR')} / 10.000 caracteres</p>
          {bodyError && <p id="comment-body-error" role="alert" className="mt-2 text-xs text-red-700">{bodyError}</p>}
          {isStaff && <div className="mt-4">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[#3d526d]">
              <input type="checkbox" name="is_internal" checked={internal} onChange={(event) => { setInternal(event.target.checked); setInternalError(null) }} disabled={busy}
                aria-describedby={`comment-internal-help${internalError ? ' comment-internal-error' : ''}`} aria-invalid={!!internalError}
                className="size-4 accent-[#2864db]" />Comentário interno
            </label>
            <p id="comment-internal-help" className="mt-1 text-xs leading-5 text-[#607189]">Visível somente à equipe de suporte.</p>
            {internalError && <p id="comment-internal-error" role="alert" className="mt-2 text-xs text-red-700">{internalError}</p>}
          </div>}
          {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
          <div className="mt-5 flex justify-end">
            <button type="submit" disabled={busy} className={`${primaryButtonClass} w-full sm:w-auto`}>
              {submitting && <span aria-hidden="true" className="size-4 rounded-full border-2 border-white/40 border-t-white motion-safe:animate-spin" />}
              {submitting ? 'Enviando mensagem...' : 'Enviar mensagem'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
