import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../services/api'
import { getAttachmentBlob, getAttachmentErrorMessage, getTicketAttachments, uploadTicketAttachment } from '../services/ticket-attachments'
import type { TicketAttachment } from '../types/ticket-attachments'
import { attachmentAccept, canPreviewAttachment, canUploadAttachment, downloadAttachmentBlob, formatAttachmentSize, validateAttachmentFile } from '../utils/ticket-attachments'
import AttachmentPreview from './attachment-preview'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'
import TicketDate from './ticket-date'

interface Result { revision: number; items: TicketAttachment[]; error: string | null; denied: boolean }

export default function TicketAttachments({ ticketId, status, onCreated }: {
  ticketId: string; status: string; onCreated: () => Promise<void>
}) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [writeBlocked, setWriteBlocked] = useState(false)
  const [preview, setPreview] = useState<{ attachment: TicketAttachment; blob: Blob } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const accessEpoch = useRef(0)
  const current = result?.revision === revision ? result : null
  const loading = current === null
  const disabled = busy !== null || loading || !!current?.denied
  const uploadAllowed = canUploadAttachment(status) && !writeBlocked && !current?.denied

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; operation.current?.abort() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const epoch = accessEpoch.current
    void getTicketAttachments(ticketId, controller.signal).then(items => {
      if (!controller.signal.aborted && epoch === accessEpoch.current) {
        setResult({ revision, items, error: null, denied: false })
        setUncertain(false)
      }
    }).catch(cause => {
      if (!controller.signal.aborted && epoch === accessEpoch.current) {
        const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status)
        if (denied) {
          accessEpoch.current++
          operation.current?.abort()
          setPreview(null)
          setFile(null)
          if (fileInput.current) fileInput.current.value = ''
        }
        setResult({ revision, items: [], error: getAttachmentErrorMessage(cause), denied })
      }
    })
    return () => { controller.abort() }
  }, [ticketId, revision])

  function handleError(cause: unknown) {
    setError(getAttachmentErrorMessage(cause))
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      accessEpoch.current++
      setResult({ revision, items: [], error: null, denied: true })
      setPreview(null)
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  function refresh() {
    if (operation.current) return
    setPreview(null)
    setError(null)
    setRevision(value => value + 1)
    if (writeBlocked) {
      void onCreated().then(() => { if (mounted.current) setWriteBlocked(false) }).catch(() => {})
    }
  }

  async function upload() {
    if (operation.current || disabled || !uploadAllowed || uncertain || current?.error) return
    const validation = validateAttachmentFile(file)
    setFileError(validation)
    if (validation || !file) { fileInput.current?.focus(); return }
    const controller = new AbortController()
    operation.current = controller
    setBusy('upload')
    setError(null)
    setMessage(null)
    try {
      await uploadTicketAttachment(ticketId, file, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      setMessage('Anexo enviado com sucesso.')
      setPreview(null)
      setRevision(value => value + 1)
      // A confirmed POST remains successful even if the details refresh fails.
      void onCreated().catch(() => {})
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return
      handleError(cause)
      if (cause instanceof ApiError && cause.status === 422) setFileError(cause.validationErrors.file?.join(' ') ?? null)
      if (cause instanceof ApiError && cause.status === 409 && cause.code === 'ticket_not_writable') {
        setWriteBlocked(true)
        void onCreated().catch(() => {})
      }
      if (!(cause instanceof ApiError) || cause.status >= 500) setUncertain(true)
    } finally {
      if (operation.current === controller) operation.current = null
      if (mounted.current) setBusy(null)
    }
  }

  async function open(attachment: TicketAttachment, mode: 'preview' | 'download', trigger: HTMLButtonElement) {
    if (operation.current || disabled) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(`${mode}:${attachment.id}`)
    setError(null)
    setPreview(null)
    try {
      const blob = await getAttachmentBlob(ticketId, attachment, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (mode === 'preview') {
        previewTrigger.current = trigger
        setPreview({ attachment, blob })
      } else downloadAttachmentBlob(blob, attachment.original_name)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) handleError(cause)
    } finally {
      if (operation.current === controller) operation.current = null
      if (mounted.current) setBusy(null)
    }
  }

  return <section aria-labelledby="attachments-title" className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="attachments-title" className="text-sm font-semibold text-[#263c57]">Anexos</h2>
      <button type="button" disabled={busy !== null || loading} onClick={refresh} className={buttonClass}>Atualizar anexos</button>
    </div>
    {loading && <p role="status" className="mt-4 text-sm text-[#607189]">Carregando anexos...</p>}
    {current?.error && <p role="alert" className="mt-4 text-sm leading-6 text-red-800">{current.error}</p>}
    {current && !current.error && !current.denied && (current.items.length === 0
      ? <p className="mt-4 text-sm text-[#607189]">Ainda não há anexos neste chamado.</p>
      : <ul aria-label="Arquivos do chamado" className="mt-4 divide-y divide-[#edf0f5]">
        {current.items.map(attachment => <li key={attachment.id} className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium wrap-anywhere text-[#263c57]">{attachment.original_name}</p>
            <p className="mt-1 text-xs leading-6 wrap-anywhere text-[#607189]">{formatAttachmentSize(attachment.size_bytes)} · {attachment.uploaded_by.name} · <TicketDate value={attachment.created_at} /></p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canPreviewAttachment(attachment) && <button type="button" disabled={disabled} aria-label={`Visualizar ${attachment.original_name}`} onClick={event => { void open(attachment, 'preview', event.currentTarget) }} className={buttonClass}>Visualizar</button>}
            <button type="button" disabled={disabled} aria-label={`Baixar ${attachment.original_name}`} onClick={event => { void open(attachment, 'download', event.currentTarget) }} className={buttonClass}>Baixar</button>
          </div>
        </li>)}
      </ul>)}
    {busy && <p role="status" className="mt-4 text-sm text-[#607189]">{busy === 'upload' ? 'Enviando anexo...' : 'Carregando arquivo...'}</p>}
    {message && <p role="status" className="mt-4 text-sm text-emerald-800">{message}</p>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
    {preview && !current?.denied && <AttachmentPreview key={preview.attachment.id} {...preview} onClose={() => {
      setPreview(null)
      previewTrigger.current?.focus()
    }} />}
    {uploadAllowed ? <div role="group" aria-label="Enviar anexo" aria-busy={busy === 'upload'} className="mt-5 border-t border-[#e9edf3] pt-5">
      <label htmlFor="attachment-file" className="text-sm font-medium text-[#263c57]">Selecionar arquivo</label>
      <p id="attachment-help" className="mt-1 text-xs leading-6 text-[#607189]">JPG, PNG, PDF ou TXT UTF-8. Até 5 MiB por arquivo, 10 anexos e 25 MiB por chamado. Um arquivo por envio.</p>
      <input ref={fileInput} type="file" id="attachment-file" name="file" accept={attachmentAccept} disabled={disabled}
        aria-invalid={!!fileError} aria-describedby={`attachment-help${fileError ? ' attachment-file-error' : ''}`}
        onChange={event => { const selected = event.currentTarget.files?.[0] ?? null; setFile(selected); setFileError(validateAttachmentFile(selected)); setMessage(null) }}
        className={`${fieldClass} mt-3 min-w-0 py-2 file:mr-3 file:rounded file:border-0 file:bg-[#edf3fc] file:px-2 file:py-1 file:text-xs file:text-[#263c57]`} />
      {fileError && <p id="attachment-file-error" role="alert" className="mt-2 text-xs text-red-700">{fileError}</p>}
      {uncertain && <p className="mt-3 text-xs leading-6 text-amber-800">Consulte “Atualizar anexos” para verificar o resultado antes de tentar outro envio. O arquivo não será reenviado automaticamente.</p>}
      <div className="mt-4 flex justify-end"><button type="button" disabled={disabled || uncertain || !!current?.error} onClick={() => { void upload() }} className={`${primaryButtonClass} w-full sm:w-auto`}>{busy === 'upload' ? 'Enviando anexo...' : 'Enviar arquivo'}</button></div>
    </div> : !current?.denied && <p className="mt-5 text-xs leading-6 text-[#607189]">Este chamado não aceita novos anexos no status atual. Os arquivos disponíveis continuam acessíveis.</p>}
  </section>
}
