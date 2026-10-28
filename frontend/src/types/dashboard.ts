import type { Ticket, TicketReference } from './tickets'

export interface DashboardStats {
  total: number
  open: number
  in_progress: number
  waiting_requester: number
  resolved: number
  closed: number
  cancelled: number
  unassigned: number
}

export interface DashboardStatsResponse {
  data: DashboardStats
}

export interface RecentTicket {
  id: number
  title: string
  status: Pick<Ticket['status'], 'code' | 'name'>
  assignee: TicketReference | null
  updated_at: string
}

export interface RecentTicketsResponse {
  data: RecentTicket[]
}

export interface DashboardSla {
  on_track: number
  at_risk: number
  overdue: number
}

export interface DashboardCategory {
  id: number
  name: string
  count: number
}
