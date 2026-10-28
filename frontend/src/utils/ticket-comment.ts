export const commentMaxLength = 10_000

export function validateTicketComment(body: string): string | null {
  if (!body.trim()) return 'Escreva uma mensagem antes de enviar.'
  if (body.length > commentMaxLength) return 'A mensagem deve ter no máximo 10.000 caracteres.'
  if (body.includes('\0')) return 'A mensagem contém um caractere inválido.'
  return null
}

export function canCommentOnTicket(status: string): boolean {
  return ['open', 'in_progress', 'waiting_requester'].includes(status)
}
