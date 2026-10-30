import type { ReportFilters, ReportPeriod } from '../types/reports'

function civil(date: string): number | null {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const value = new Date(`${date}T00:00:00Z`).getTime()
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : null
}

export function defaultReportFilters(now = new Date()): ReportFilters {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (name: string) => parts.find(p => p.type === name)!.value
  const end_date = `${part('year')}-${part('month')}-${part('day')}`
  const start_date = new Date(civil(end_date)! - 29 * 86400000).toISOString().slice(0, 10)
  return { start_date, end_date, assigned_to: '', category_id: '', priority: '', status: '', page: 1, per_page: 15 }
}

export function validateReportPeriod(period: ReportPeriod): string | null {
  const start = civil(period.start_date), end = civil(period.end_date)
  if (start === null || end === null) return 'Informe duas datas existentes no formato indicado.'
  if (end < start) return 'A data final deve ser igual ou posterior à data inicial.'
  const date = new Date(start), year = date.getUTCFullYear() + 1, month = date.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const anniversary = new Date(0)
  anniversary.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay))
  if (end + 86400000 > anniversary.getTime()) return 'Selecione no máximo um ano de calendário.'
  return null
}

export function reportParams(filters: ReportPeriod | ReportFilters, table = false): URLSearchParams {
  const error = validateReportPeriod(filters)
  if (error) throw new Error(error)
  const params = new URLSearchParams({ start_date: filters.start_date, end_date: filters.end_date })
  if (table && 'page' in filters) {
    for (const key of ['assigned_to', 'category_id', 'priority', 'status'] as const) if (filters[key]) params.set(key, filters[key])
    params.set('page', String(filters.page)); params.set('per_page', String(filters.per_page))
  }
  return params
}
