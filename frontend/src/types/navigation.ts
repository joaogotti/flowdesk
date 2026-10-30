export type WorkspacePage = 'overview' | 'tickets' | 'new-ticket' | 'ticket-details' | 'categories' | 'users' | 'reports'

export type WorkspaceRoute =
  | { page: 'ticket-details'; ticketId: string | null }
  | { page: Exclude<WorkspacePage, 'ticket-details'> }

export const pageLabels: Record<WorkspacePage, string> = {
  overview: 'Visão geral',
  categories: 'Categorias',
  users: 'Usuários',
  reports: 'Relatórios',
  tickets: 'Chamados',
  'new-ticket': 'Novo chamado',
  'ticket-details': 'Detalhes do chamado',
}
