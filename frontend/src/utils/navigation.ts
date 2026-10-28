import type { WorkspaceRoute } from '../types/navigation'

export function isValidTicketId(id: string): boolean {
  const maximum = '9223372036854775807'
  return /^[1-9]\d*$/.test(id) &&
    (id.length < maximum.length || (id.length === maximum.length && id <= maximum))
}

export function parseWorkspaceHash(hash: string): WorkspaceRoute {
  if (hash === '#/usuarios') return { page: 'users' }
  if (hash === '#/categorias') return { page: 'categories' }
  if (hash === '#/chamados/novo') return { page: 'new-ticket' }
  if (hash === '#/chamados') return { page: 'tickets' }
  if (hash.startsWith('#/chamados/')) {
    const id = hash.slice('#/chamados/'.length)
    return { page: 'ticket-details', ticketId: isValidTicketId(id) ? id : null }
  }
  return { page: 'overview' }
}
