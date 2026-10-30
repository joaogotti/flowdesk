export type AttachmentMime = 'image/jpeg' | 'image/png' | 'application/pdf' | 'text/plain'

export interface TicketAttachment {
  id: number
  original_name: string
  mime_type: AttachmentMime
  size_bytes: number
  uploaded_by: { id: number; name: string }
  created_at: string
  confirmed_at: string
}
