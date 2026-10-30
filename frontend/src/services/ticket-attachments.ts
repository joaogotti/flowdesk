import { ApiError, apiBlobRequest, apiRequest, initializeCsrf } from './api'
import type { AttachmentMime, TicketAttachment } from '../types/ticket-attachments'
import { isValidTicketId } from '../utils/navigation'
import { attachmentMaxBytes, validateAttachmentFile } from '../utils/ticket-attachments'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function parseAttachment(value: unknown): TicketAttachment {
  if (!record(value) || !positiveId(value.id) || typeof value.original_name !== 'string' ||
    !value.original_name || /[\p{C}\\/]/u.test(value.original_name) ||
    typeof value.mime_type !== 'string' || !['image/jpeg', 'image/png', 'application/pdf', 'text/plain'].includes(value.mime_type) ||
    !positiveId(value.size_bytes) || value.size_bytes > attachmentMaxBytes ||
    !record(value.uploaded_by) || !positiveId(value.uploaded_by.id) || typeof value.uploaded_by.name !== 'string' ||
    !date(value.created_at) || !date(value.confirmed_at)) {
    throw new Error('A resposta de anexos não possui o formato esperado. Atualize a listagem antes de tentar novamente.')
  }
  return {
    id: value.id, original_name: value.original_name, mime_type: value.mime_type as AttachmentMime,
    size_bytes: value.size_bytes, uploaded_by: { id: value.uploaded_by.id, name: value.uploaded_by.name },
    created_at: value.created_at, confirmed_at: value.confirmed_at,
  }
}
function path(ticketId: string): string {
  if (!isValidTicketId(ticketId)) throw new Error('O identificador do chamado é inválido.')
  return `/tickets/${ticketId}/attachments`
}

export async function getTicketAttachments(ticketId: string, signal?: AbortSignal): Promise<TicketAttachment[]> {
  const data = await apiRequest(path(ticketId), { signal, cache: 'no-store' }, 200)
  if (!record(data) || !Array.isArray(data.data) || data.data.length > 10) throw new Error('Não foi possível ler a listagem de anexos.')
  const attachments = data.data.map(parseAttachment)
  if (new Set(attachments.map(item => item.id)).size !== attachments.length) throw new Error('A listagem de anexos é inválida.')
  return attachments
}

export async function uploadTicketAttachment(ticketId: string, file: File, signal?: AbortSignal): Promise<TicketAttachment> {
  const url = path(ticketId)
  const error = validateAttachmentFile(file)
  if (error) throw new Error(error)
  const body = new FormData()
  body.append('file', file)
  await initializeCsrf()
  if (signal?.aborted) throw new Error('Envio cancelado.')
  const data = await apiRequest(url, { method: 'POST', body, signal }, 201)
  if (!record(data)) throw new Error('O envio não foi confirmado. Atualize a listagem antes de tentar novamente.')
  return parseAttachment(data.data)
}

export async function getAttachmentBlob(ticketId: string, attachment: TicketAttachment, signal?: AbortSignal): Promise<Blob> {
  const url = path(ticketId)
  if (!positiveId(attachment.id)) throw new Error('O identificador do anexo é inválido.')
  const blob = await apiBlobRequest(`${url}/${attachment.id}/download`, { signal })
  if (!(blob instanceof Blob) || blob.size !== attachment.size_bytes || blob.type.split(';')[0].trim() !== attachment.mime_type) {
    throw new Error('Não foi possível verificar o arquivo recebido. Atualize os anexos antes de tentar novamente.')
  }
  return blob
}

export function getAttachmentErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return cause.code === 'session_revoked'
        ? 'Sua sessão foi revogada. Entre novamente para acessar os anexos.'
        : 'Sua sessão expirou. Entre novamente para acessar os anexos.'
      case 403: return 'Você não tem permissão para acessar os anexos ou sua conta está desativada.'
      case 404: return 'O chamado ou anexo não existe ou não está disponível para sua conta.'
      case 409:
        switch (cause.code) {
          case 'ticket_not_writable': return 'O chamado não aceita novos anexos no status atual. Atualize os detalhes.'
          case 'attachment_limit_reached': return 'Limite de 10 anexos ou 25 MiB por chamado atingido. Reservas pendentes também ocupam espaço.'
          case 'attachment_reservation_expired': return 'A reserva de envio expirou. Atualize os anexos antes de tentar novamente.'
          default: return 'Não foi possível concluir a operação. Atualize os anexos antes de tentar novamente.'
        }
      case 413: return 'O arquivo ou a requisição excede o limite permitido. Envie somente um arquivo de até 5 MiB.'
      case 419: return 'Não foi possível validar sua sessão. Entre novamente se o erro persistir.'
      case 422: return cause.validationErrors.file?.join(' ') || 'Arquivo inválido. Revise formato, nome e tamanho; TXT deve estar em UTF-8.'
      case 429: return 'Limite de 10 tentativas de upload por minuto atingido. Aguarde um minuto antes de tentar novamente.'
      case 503: return 'O armazenamento de anexos está temporariamente indisponível. Atualize a listagem antes de repetir um envio.'
    }
  }
  return 'Não foi possível concluir a operação. Verifique sua conexão e atualize a listagem antes de repetir um envio.'
}
