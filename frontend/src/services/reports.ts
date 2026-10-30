import { ApiError, apiBlobRequest, apiRequest } from './api'
import type { ReportFilters, ReportOptions, ReportPeriod, ReportSla, ReportSummary, ReportTickets } from '../types/reports'
import { reportSlaLabels } from '../types/reports'
import { reportParams } from '../utils/reports'

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const nullableDate = (v: unknown) => v === null || date(v)
const reference = (v: unknown) => record(v) && integer(v.id) && v.id > 0 && typeof v.name === 'string'
const state = (v: unknown) => typeof v === 'string' && Object.hasOwn(reportSlaLabels, v)
const meta = (v: unknown, p: ReportPeriod) => record(v) && date(v.as_of) && v.timezone === 'America/Sao_Paulo' && v.start_date === p.start_date && v.end_date === p.end_date
function invalid(): never { throw new Error('A resposta de relatórios não possui o formato esperado.') }
function sla(value: unknown, total: number): value is ReportSla {
  if (!record(value) || !Object.keys(reportSlaLabels).every(key => integer(value[key])) ||
    !integer(value.cancelled_excluded) || !integer(value.compliance_denominator)) return false
  const sum = Object.keys(reportSlaLabels).reduce((n, key) => n + (value[key] as number), 0)
  const denominator = (value.met as number) + (value.late as number)
  return sum === total && value.cancelled_excluded <= (value.not_evaluable as number) && value.compliance_denominator === denominator &&
    (denominator === 0 ? value.compliance_rate === null : typeof value.compliance_rate === 'number' && Number.isFinite(value.compliance_rate) &&
      Math.abs(value.compliance_rate - Math.round(10000 * (value.met as number) / denominator) / 100) < 0.001)
}

export async function getReportSummary(period: ReportPeriod, signal?: AbortSignal): Promise<ReportSummary> {
  const value = await apiRequest(`/reports/summary?${reportParams(period)}`, { signal, cache: 'no-store' }, 200)
  if (!record(value) || !meta(value.meta, period) || !record(value.data)) invalid()
  const d = value.data
  if (!record(d.movements) || !['created', 'resolved_distinct', 'closed'].every(k => integer((d.movements as Record<string, unknown>)[k])) ||
    !record(d.cohort) || !integer(d.cohort.total) || d.cohort.total !== d.movements.created || d.cohort.scope !== 'tickets_created_in_period' ||
    !record(d.cohort.unassigned) || !integer(d.cohort.unassigned.count) || d.cohort.unassigned.count > d.cohort.total ||
    !Array.isArray(d.cohort.by_status) || !d.cohort.by_status.every(r => record(r) && typeof r.code === 'string' && typeof r.name === 'string' && integer(r.count)) ||
    !Array.isArray(d.cohort.by_category) || !d.cohort.by_category.every(r => reference(r) && record(r) && typeof r.is_active === 'boolean' && integer(r.count)) ||
    !Array.isArray(d.cohort.by_priority) || !d.cohort.by_priority.every(r => record(r) && typeof r.code === 'string' && integer(r.count)) ||
    !record(d.sla) || d.sla.basis !== 'currently_recorded_deadlines' || typeof d.sla.note !== 'string' ||
    !sla(d.sla.first_response, d.cohort.total) || !sla(d.sla.resolution, d.cohort.total)) invalid()
  for (const list of [d.cohort.by_status, d.cohort.by_category, d.cohort.by_priority]) {
    if (list.reduce((n, r) => n + r.count, 0) !== d.cohort.total) invalid()
  }
  return value as unknown as ReportSummary
}

export async function getReportOptions(period: ReportPeriod, signal?: AbortSignal): Promise<ReportOptions> {
  const value = await apiRequest(`/reports/filters?${reportParams(period)}`, { signal, cache: 'no-store' }, 200)
  if (!record(value) || !meta(value.meta, period) || !record(value.data)) invalid()
  const d = value.data
  if (d.unassigned_value !== 'unassigned' || !Array.isArray(d.assignees) || !d.assignees.every(r => reference(r) && record(r) && typeof r.role === 'string' && typeof r.is_active === 'boolean') ||
    !Array.isArray(d.categories) || !d.categories.every(r => reference(r) && record(r) && typeof r.is_active === 'boolean') ||
    !Array.isArray(d.statuses) || !d.statuses.every(r => reference(r) && record(r) && typeof r.code === 'string') ||
    !Array.isArray(d.priorities) || !d.priorities.every(r => typeof r === 'string')) invalid()
  return d as unknown as ReportOptions
}

export async function getReportTickets(filters: ReportFilters, signal?: AbortSignal): Promise<ReportTickets> {
  const value = await apiRequest(`/reports/tickets?${reportParams(filters, true)}`, { signal, cache: 'no-store' }, 200)
  if (!record(value) || !meta(value.meta, filters) || !record(value.meta) || value.meta.summary_filters_applied !== false ||
    value.meta.sla_basis !== 'currently_recorded_deadlines' || !record(value.meta.filters) ||
    !integer(value.total) || value.current_page !== filters.page || value.per_page !== filters.per_page || !integer(value.last_page) || value.last_page < 1 ||
    !(value.from === null || integer(value.from)) || !(value.to === null || integer(value.to)) ||
    !Array.isArray(value.data) || value.data.length > filters.per_page || !value.data.every(r =>
      record(r) && integer(r.id) && r.id > 0 && typeof r.title === 'string' && typeof r.priority === 'string' && reference(r.requester) &&
      (r.assignee === null || reference(r.assignee)) && reference(r.category) && reference(r.status) && record(r.status) && typeof r.status.code === 'string' &&
      date(r.created_at) && date(r.first_response_due_at) && date(r.resolution_due_at) && nullableDate(r.first_responded_at) && nullableDate(r.resolved_at) && nullableDate(r.closed_at) &&
      record(r.sla) && state(r.sla.first_response) && state(r.sla.resolution))) invalid()
  for (const key of ['assigned_to', 'category_id', 'priority', 'status'] as const) {
    if (String(value.meta.filters[key] ?? '') !== filters[key]) invalid()
  }
  return value as unknown as ReportTickets
}

export async function getReportCsv(filters: ReportFilters, signal?: AbortSignal): Promise<Blob> {
  const blob = await apiBlobRequest(`/reports/tickets/export?${reportParams(filters, true)}`, { signal })
  const prefix = new Uint8Array(await blob.slice(0, 3).arrayBuffer())
  if (blob.type.split(';')[0] !== 'text/csv' || prefix[0] !== 239 || prefix[1] !== 187 || prefix[2] !== 191) invalid()
  return blob
}

export function getReportError(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.status) {
      case 401: return cause.code === 'session_revoked' ? 'Sua sessão foi revogada. Entre novamente.' : 'Sua sessão expirou. Entre novamente.'
      case 403: return 'Somente administradores ativos podem acessar os relatórios.'
      case 419: return 'Não foi possível validar sua sessão. Entre novamente se o erro persistir.'
      case 422: return cause.code === 'export_limit_exceeded' ? 'A exportação permite no máximo 5.000 chamados. Restrinja os filtros e tente novamente.' : 'Filtros inválidos. Revise as datas e as opções selecionadas.'
      case 429: return 'Muitas solicitações. Aguarde um momento antes de tentar novamente.'
      case 503: return 'Os relatórios estão temporariamente indisponíveis. Tente novamente mais tarde.'
    }
  }
  return 'Não foi possível carregar os relatórios. Verifique sua conexão e tente novamente.'
}
