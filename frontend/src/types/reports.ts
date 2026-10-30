export const reportSlaLabels = {
  met: 'Cumprido no prazo', late: 'Cumprido com atraso', pending_on_time: 'Pendente dentro do prazo',
  pending_overdue: 'Pendente vencido', not_evaluable: 'Não avaliável',
} as const
export type ReportSlaState = keyof typeof reportSlaLabels
export interface ReportPeriod { start_date: string; end_date: string }
export interface ReportFilters extends ReportPeriod {
  assigned_to: string; category_id: string; priority: string; status: string; page: number; per_page: number
}
export interface ReportSla extends Record<ReportSlaState, number> {
  cancelled_excluded: number; compliance_denominator: number; compliance_rate: number | null
}
export interface ReportMeta extends ReportPeriod { as_of: string; timezone: string }
export interface ReportSummary {
  data: {
    movements: { created: number; resolved_distinct: number; closed: number }
    cohort: {
      scope: string; total: number; unassigned: { count: number; scope: string }
      by_status: { code: string; name: string; count: number }[]
      by_category: { id: number; name: string; is_active: boolean; count: number }[]
      by_priority: { code: string; count: number }[]
    }
    sla: { scope: string; basis: string; note: string; first_response: ReportSla; resolution: ReportSla }
  }
  meta: ReportMeta
}
export interface ReportOptions {
  assignees: { id: number; name: string; role: string; is_active: boolean }[]
  categories: { id: number; name: string; is_active: boolean }[]
  statuses: { id: number; code: string; name: string }[]
  priorities: string[]; unassigned_value: string
}
export interface ReportTicket {
  id: number; title: string; priority: string
  requester: { id: number; name: string }; assignee: { id: number; name: string } | null
  category: { id: number; name: string }; status: { id: number; code: string; name: string }
  created_at: string; first_responded_at: string | null; resolved_at: string | null; closed_at: string | null
  first_response_due_at: string; resolution_due_at: string
  sla: { first_response: ReportSlaState; resolution: ReportSlaState }
}
export interface ReportTickets {
  data: ReportTicket[]; total: number; current_page: number; last_page: number; per_page: number
  from: number | null; to: number | null
  meta: ReportMeta & { filters: Record<string, string | number>; summary_filters_applied: boolean; sla_basis: string }
}
