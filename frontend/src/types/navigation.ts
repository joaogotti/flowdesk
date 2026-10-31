export type WorkspacePage = 'overview' | 'tickets' | 'new-ticket' | 'ticket-details' | 'categories' | 'users' | 'reports' | 'settings'

export type WorkspaceRoute =
  | { page: 'ticket-details'; ticketId: string | null }
  | { page: Exclude<WorkspacePage, 'ticket-details'> }

export const pageLabels: Record<WorkspacePage, string> = {
  settings: 'Configurações',
  overview: 'Visão geral',
  categories: 'Categorias',
  users: 'Usuários',
  reports: 'Relatórios',
  tickets: 'Chamados',
  'new-ticket': 'Novo chamado',
  'ticket-details': 'Detalhes do chamado',
}
