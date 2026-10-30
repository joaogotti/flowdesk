// Mirrors public backend contracts; synthetic data only.
export function reportFixtures(period = { start_date: '2026-10-01', end_date: '2026-10-30' }, params = {}) {
  const meta = { ...period, as_of: '2026-10-30T15:00:00.000000Z', timezone: 'America/Sao_Paulo',
    start_utc: period.start_date + 'T03:00:00.000000Z', end_exclusive_utc: '2026-10-31T03:00:00.000000Z' }
  const statuses = ['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled'].map((code, index) => ({ id: index + 1, code, name: ['Aberto', 'Em andamento', 'Aguardando solicitante', 'Resolvido', 'Fechado', 'Cancelado'][index] }))
  const priorities = ['low', 'medium', 'high', 'urgent']
  const empty = { met: 0, late: 0, pending_on_time: 0, pending_overdue: 0, not_evaluable: 0, cancelled_excluded: 0, compliance_denominator: 0, compliance_rate: null }
  const summary = { data: {
    movements: { created: 3, resolved_distinct: 4, closed: 2 },
    cohort: { scope: 'tickets_created_in_period', total: 3, unassigned: { count: 2, scope: 'all_cohort_tickets_including_final_and_cancelled' },
      by_status: statuses.map(s => ({ code: s.code, name: s.name, count: s.code === 'open' ? 2 : s.code === 'resolved' ? 1 : 0 })),
      by_category: [{ id: 1, name: 'Categoria histórica', is_active: false, count: 3 }],
      by_priority: priorities.map(code => ({ code, count: code === 'medium' ? 3 : 0 })) },
    sla: { scope: 'tickets_created_in_period', basis: 'currently_recorded_deadlines', note: 'Prazos atualmente registrados.',
      first_response: { ...empty, met: 1, late: 1, pending_on_time: 1, compliance_denominator: 2, compliance_rate: 50 },
      resolution: { ...empty, pending_on_time: 2, not_evaluable: 1 } },
  }, meta: { ...meta, resolution_source: 'distinct_tickets_with_recorded_status_changed_to_resolved_events' } }
  const options = { data: { assignees: [{ id: 8, name: 'Responsável histórico', role: 'admin', is_active: false }, { id: 9, name: 'Técnico atual', role: 'technician', is_active: true }],
    categories: [{ id: 1, name: 'Categoria histórica', is_active: false }, { id: 2, name: 'Categoria atual', is_active: true }],
    statuses, priorities, unassigned_value: 'unassigned' }, meta: { ...meta, options_scope: 'administrative_catalog_across_all_periods' } }
  const filters = Object.fromEntries(['assigned_to', 'category_id', 'priority', 'status'].filter(k => params[k]).map(k => [k, ['assigned_to', 'category_id'].includes(k) && params[k] !== 'unassigned' ? Number(params[k]) : params[k]]))
  const page = Number(params.page || 1), per_page = Number(params.per_page || 15), total = 31, offset = (page - 1) * per_page
  const data = Array.from({ length: Math.max(0, Math.min(per_page, total - offset)) }, (_, i) => ({
    id: 1000 - offset - i, title: `Chamado de relatório ${offset + i + 1}`, requester: { id: 9, name: 'Solicitante de teste' },
    assignee: params.assigned_to === 'unassigned' ? null : { id: Number(params.assigned_to || 8), name: 'Responsável histórico' },
    category: { id: Number(params.category_id || 1), name: 'Categoria histórica' }, priority: params.priority || 'medium',
    status: statuses.find(s => s.code === params.status) || statuses[0], created_at: period.start_date + 'T12:00:00.000000Z',
    first_responded_at: null, resolved_at: null, closed_at: null, first_response_due_at: period.end_date + 'T20:00:00.000000Z', resolution_due_at: period.end_date + 'T22:00:00.000000Z',
    sla: { first_response: 'pending_on_time', resolution: 'pending_overdue' },
  }))
  const table = { data, total, current_page: page, last_page: Math.ceil(total / per_page), per_page, from: data.length ? offset + 1 : null, to: data.length ? offset + data.length : null,
    meta: { ...meta, filters, scope: 'tickets_created_in_period', summary_filters_applied: false, sla_basis: 'currently_recorded_deadlines' } }
  return { summary, options, table }
}
