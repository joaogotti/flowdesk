import type { TicketAttachment } from '../types/ticket-attachments'

export const attachmentMaxBytes = 5 * 1024 * 1024
export const attachmentAccept = '.jpg,.jpeg,.png,.pdf,.txt,image/jpeg,image/png,application/pdf,text/plain'
const formats: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', txt: 'text/plain' }

export function validateAttachmentFile(file: File | null): string | null {
  if (!file) return 'Selecione um arquivo para enviar.'
  if (file.size === 0) return 'O arquivo está vazio.'
  if (file.size > attachmentMaxBytes) return 'O arquivo deve ter no máximo 5 MiB.'
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  const mime = formats[extension]
  if (!mime || (file.type && file.type.toLowerCase() !== mime)) return 'Selecione um arquivo JPG, PNG, PDF ou TXT UTF-8 com formato e extensão compatíveis.'
  return null
}

export function formatAttachmentSize(bytes: number): string {
  const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
  if (bytes < 1024) return `${number.format(bytes)} B`
  if (bytes < 1024 * 1024) return `${number.format(bytes / 1024)} KiB`
  return `${number.format(bytes / (1024 * 1024))} MiB`
}

export function canUploadAttachment(status: string): boolean {
  return ['open', 'in_progress', 'waiting_requester'].includes(status)
}

export function canPreviewAttachment(attachment: TicketAttachment): boolean {
  return ['image/jpeg', 'image/png', 'text/plain'].includes(attachment.mime_type)
}

// The server filename is display data, never a URL or a storage path.
export function downloadAttachmentBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.replace(/[\p{C}\\/]/gu, '_')
  link.hidden = true
  document.body.append(link)
  try { link.click() } finally {
    link.remove()
    // Allow the browser to consume the download before releasing its object URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
