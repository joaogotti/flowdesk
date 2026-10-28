// Códigos definidos em TicketStatusSeeder e IndexTicketRequest no backend.
export const ticketStatusLabels = {
  open: 'Aberto',
  in_progress: 'Em andamento',
  waiting_requester: 'Aguardando solicitante',
  resolved: 'Resolvido',
  closed: 'Fechado',
  cancelled: 'Cancelado',
} as const

export const ticketPriorityLabels = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  urgent: 'Crítica',
} as const

export type TicketStatusCode = keyof typeof ticketStatusLabels
export type TicketPriority = keyof typeof ticketPriorityLabels

export interface TicketStatusInput {
  status: TicketStatusCode
}

export interface UpdateTicketDetailsInput {
  category_id?: number
  priority?: TicketPriority
}

export interface CreateTicketInput {
  title: string
  description: string
  category_id: number
  priority: TicketPriority
}

export interface CreateTicketResponse {
  id: number
}

export interface TicketReference {
  id: number
  name: string
}

export interface TicketAssignmentInput {
  assigned_to: number | null
}

export interface TicketAssignmentResponse {
  id: number
  assignee: TicketReference | null
  updated_at: string
}

export interface Ticket {
  id: number
  title: string
  priority: TicketPriority
  status: TicketReference & { code: string }
  category: TicketReference
  requester: TicketReference
  assignee: TicketReference | null
  created_at: string
  first_response_due_at: string
  resolution_due_at: string
}

export interface TicketFilters {
  search: string
  status: TicketStatusCode | ''
  priority: TicketPriority | ''
  page: number
}

export interface TicketComment {
  id: number
  author: TicketReference
  body: string
  is_internal?: boolean
  created_at: string
}

export interface CreateTicketCommentInput {
  body: string
  is_internal: boolean
}

export interface TicketActivity {
  id: number
  action: string
  actor: TicketReference | null
  created_at: string
  details?: TicketActivityDetails
}

export interface TicketActivityReference {
  id: number
  name: string | null
}

export interface TicketActivityTransition<T> {
  from?: T | null
  to?: T | null
}

export interface TicketActivityDetails {
  assignee?: TicketActivityTransition<TicketActivityReference>
  status?: TicketActivityTransition<TicketStatusCode>
  category?: TicketActivityTransition<TicketActivityReference>
  priority?: TicketActivityTransition<TicketPriority>
}

export interface TicketDetails extends Ticket {
  description: string
  updated_at: string
  first_responded_at: string | null
  resolved_at: string | null
  closed_at: string | null
  comments: TicketComment[]
  activities: TicketActivity[]
}

export interface TicketsResponse {
  data: Ticket[]
  current_page: number
  last_page: number
  per_page: number
  total: number
  from: number | null
  to: number | null
  first_page_url: string
  last_page_url: string
  next_page_url: string | null
  prev_page_url: string | null
  path: string
  links: { url: string | null; label: string; active: boolean }[]
}
