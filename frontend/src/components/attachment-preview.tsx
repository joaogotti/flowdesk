import { useEffect, useRef, useState } from 'react'
import type { TicketAttachment } from '../types/ticket-attachments'
import { buttonClass } from './control-styles'

export default function AttachmentPreview({ attachment, blob, onClose }: {
  attachment: TicketAttachment; blob: Blob; onClose: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    heading.current?.focus()
    if (attachment.mime_type === 'text/plain') {
      let active = true
      void blob.arrayBuffer().then(buffer => {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        if (active) setText(content)
      }).catch(() => { if (active) setError('Não foi possível visualizar este TXT em UTF-8.') })
      return () => { active = false }
    }
    if (attachment.mime_type !== 'image/jpeg' && attachment.mime_type !== 'image/png') return
    const url = URL.createObjectURL(blob)
    const element = image.current
    if (element) element.src = url
    return () => { element?.removeAttribute('src'); URL.revokeObjectURL(url) }
  }, [attachment.mime_type, blob])

  return <div role="region" aria-labelledby="attachment-preview-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
  }} className="mt-5 min-w-0 rounded-lg border border-[#dce3ed] bg-[#f8fafc] p-4">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <h3 id="attachment-preview-title" tabIndex={-1} ref={heading} className="min-w-0 text-sm font-medium wrap-anywhere text-[#263c57] outline-none">Visualização: {attachment.original_name}</h3>
      <button type="button" onClick={onClose} className={buttonClass}>Fechar visualização</button>
    </div>
    {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : attachment.mime_type === 'text/plain'
      ? text === null ? <p role="status" className="text-sm text-[#607189]">Carregando texto...</p>
        : <pre tabIndex={0} aria-label={`Conteúdo de ${attachment.original_name}`} className="max-h-96 overflow-auto text-xs leading-6 whitespace-pre-wrap wrap-anywhere text-[#3d526d]">{text}</pre>
      : <img ref={image} alt={`Anexo ${attachment.original_name}`} onError={() => setError('Não foi possível visualizar esta imagem.')} className="mx-auto max-h-96 max-w-full object-contain" />}
  </div>
}
