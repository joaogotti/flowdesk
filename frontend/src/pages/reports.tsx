import { useEffect, useRef, useState } from 'react'
import type { ReactNode, SubmitEvent } from 'react'
import type { AuthenticatedUser } from '../types/auth'
import type { ReportFilters, ReportOptions, ReportSummary, ReportTickets } from '../types/reports'
import { ticketPriorityLabels } from '../types/tickets'
import { ApiError, onSessionRevoked } from '../services/api'
import { getReportCsv, getReportError, getReportOptions, getReportSummary, getReportTickets } from '../services/reports'
import { defaultReportFilters, validateReportPeriod } from '../utils/reports'
import { downloadAttachmentBlob } from '../utils/ticket-attachments'
import { buttonClass, fieldClass, primaryButtonClass } from '../components/control-styles'
import MetricCard from '../components/metric-card'
import ReportDistribution from '../components/report-distribution'
import ReportSlaIndicator from '../components/report-sla'
import ReportTicketsTable from '../components/report-tickets-table'
import TicketDate from '../components/ticket-date'

interface Result<T> { key: string; data: T | null; error: string | null }

export default function Reports({ user }: { user: AuthenticatedUser }) {
  if (user.role !== 'admin') return <div role="alert" className="rounded-xl border border-[#e0e6ee] bg-white p-6"><h1 className="text-xl font-semibold text-[#172b45]">Acesso não permitido</h1><p className="mt-3 text-sm text-[#607189]">Somente administradores podem acessar os relatórios.</p><a href="#/visao-geral" className={`${buttonClass} mt-5`}>Voltar à Visão geral</a></div>
  return <AdministrativeReports key={user.id} />
}

function AdministrativeReports() {
  const [applied, setApplied] = useState<ReportFilters>(defaultReportFilters)
  const [draft, setDraft] = useState(applied)
  const [attempt, setAttempt] = useState(0)
  const [summaryResult, setSummary] = useState<Result<ReportSummary> | null>(null)
  const [optionsResult, setOptions] = useState<Result<ReportOptions> | null>(null)
  const [tableResult, setTable] = useState<Result<ReportTickets> | null>(null)
  const [periodError, setPeriodError] = useState<string | null>(null)
  const [denied, setDenied] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exported, setExported] = useState(false)
  const controllers = useRef(new Map<string, AbortController>())
  const exportController = useRef<AbortController | null>(null)
  const blocked = useRef(false)
  const focusNext = useRef(false)
  const tableHeading = useRef<HTMLHeadingElement>(null)
  const periodKey = JSON.stringify([applied.start_date, applied.end_date, attempt])
  const tableKey = JSON.stringify([applied, attempt])
  const summary = summaryResult?.key === periodKey ? summaryResult : null
  const options = optionsResult?.key === periodKey ? optionsResult : null
  const table = tableResult?.key === tableKey ? tableResult : null
  const dirty = (Object.keys(draft) as (keyof ReportFilters)[]).some(key => key !== 'page' && draft[key] !== applied[key])

  useEffect(() => {
    const pending = controllers.current
    const unsubscribe = onSessionRevoked(() => {
      blocked.current = true
      pending.forEach(c => c.abort())
      exportController.current?.abort()
    })
    return () => { unsubscribe(); pending.forEach(c => c.abort()); exportController.current?.abort() }
  }, [])

  function accessFailure(cause: unknown): boolean {
    if (cause instanceof ApiError && [401, 403, 419].includes(cause.status)) {
      blocked.current = true
      controllers.current.forEach(c => c.abort())
      exportController.current?.abort()
      setDenied(getReportError(cause))
      return true
    }
    return false
  }

  useEffect(() => {
    const controller = new AbortController(); controllers.current.set('summary', controller)
    const timer = window.setTimeout(() => {
      void getReportSummary({ start_date: applied.start_date, end_date: applied.end_date }, controller.signal).then(data => {
        if (!controller.signal.aborted && !blocked.current) setSummary({ key: periodKey, data, error: null })
      }).catch(cause => { if (!controller.signal.aborted && !accessFailure(cause)) setSummary({ key: periodKey, data: null, error: getReportError(cause) }) })
    }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [applied.start_date, applied.end_date, periodKey])

  useEffect(() => {
    const controller = new AbortController(); controllers.current.set('options', controller)
    const timer = window.setTimeout(() => {
      void getReportOptions({ start_date: applied.start_date, end_date: applied.end_date }, controller.signal).then(data => {
        if (!controller.signal.aborted && !blocked.current) setOptions({ key: periodKey, data, error: null })
      }).catch(cause => { if (!controller.signal.aborted && !accessFailure(cause)) setOptions({ key: periodKey, data: null, error: getReportError(cause) }) })
    }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [applied.start_date, applied.end_date, periodKey])

  useEffect(() => {
    const controller = new AbortController(); controllers.current.set('table', controller)
    const timer = window.setTimeout(() => {
      void getReportTickets(applied, controller.signal).then(data => {
        if (!controller.signal.aborted && !blocked.current) setTable({ key: tableKey, data, error: null })
      }).catch(cause => { if (!controller.signal.aborted && !accessFailure(cause)) setTable({ key: tableKey, data: null, error: getReportError(cause) }) })
    }, 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [applied, tableKey])

  useEffect(() => {
    if (table && focusNext.current) { focusNext.current = false; tableHeading.current?.focus({ preventScroll: true }) }
  }, [table])

  function retry() {
    blocked.current = false
    setDenied(null)
    setAttempt(value => value + 1)
  }
  function apply(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const error = validateReportPeriod(draft)
    setPeriodError(error)
    if (error) { document.getElementById('report-start')?.focus(); return }
    if (exportController.current) return
    setExportError(null); setExported(false)
    focusNext.current = true
    setApplied({ ...draft, page: 1 })
  }
  async function download() {
    if (exportController.current || dirty || !table?.data || blocked.current) return
    const controller = new AbortController(); exportController.current = controller
    setExporting(true); setExportError(null); setExported(false)
    try {
      const blob = await getReportCsv(applied, controller.signal)
      if (!controller.signal.aborted && !blocked.current) { downloadAttachmentBlob(blob, 'flowdesk-chamados.csv'); setExported(true) }
    } catch (cause) {
      if (!controller.signal.aborted && !accessFailure(cause)) setExportError(getReportError(cause))
    } finally {
      if (exportController.current === controller) { exportController.current = null; setExporting(false) }
    }
  }
  function edit(key: keyof ReportFilters, value: string | number) { focusNext.current = false; setDraft(current => ({ ...current, [key]: value })); setPeriodError(null); setExported(false) }
  const fieldLabel = 'block text-xs font-medium text-[#52657d]'
  const available: Partial<Record<keyof ReportFilters, string[]>> = {
    assigned_to: ['', 'unassigned', ...(options?.data?.assignees.map(r => String(r.id)) ?? [])],
    category_id: ['', ...(options?.data?.categories.map(r => String(r.id)) ?? [])],
    priority: ['', ...(options?.data?.priorities ?? [])], status: ['', ...(options?.data?.statuses.map(r => r.code) ?? [])],
    per_page: ['15', '30', '50', '100'],
  }
  const select = (id: string, label: string, key: keyof ReportFilters, children: ReactNode) => <label htmlFor={id} className={fieldLabel}>{label}<select id={id} value={draft[key]} onChange={event => edit(key, key === 'per_page' ? Number(event.target.value) : event.target.value)} disabled={exporting || !options?.data} className={`${fieldClass} mt-2`}>{!available[key]?.includes(String(draft[key])) && <option value={draft[key]}>Selecionado: {String(draft[key])}</option>}{children}</select></label>

  if (denied) return <div role="alert" className="rounded-xl border border-[#e0e6ee] bg-white p-6"><h1 className="text-xl font-semibold text-[#172b45]">Relatórios indisponíveis para esta sessão</h1><p className="mt-3 text-sm text-[#607189]">{denied}</p><button type="button" className={`${buttonClass} mt-5`} onClick={retry}>Verificar acesso novamente</button></div>

  return <>
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-[10px] font-semibold tracking-[0.15em] text-[#607189]">ANÁLISE OPERACIONAL</p><h1 className="mt-2 text-[28px] font-semibold tracking-[-0.035em] text-[#172b45]">Relatórios</h1><p className="mt-2 text-sm leading-6 text-[#607189]">Movimentos do período e situação atual dos chamados criados nesse intervalo.</p></div><button type="button" className={`${primaryButtonClass} w-full sm:w-auto`} onClick={() => { void download() }} disabled={exporting || dirty || !table?.data}>{exporting ? 'Preparando CSV...' : 'Exportar CSV'}</button></div>
    {exportError && <p role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{exportError}</p>}
    {exported && <p role="status" className="mb-5 text-sm text-emerald-800">Download do CSV iniciado. Limite: 5.000 chamados; a exportação inclui todas as páginas da seleção.</p>}
    <form aria-label="Filtros dos relatórios" onSubmit={apply} noValidate className="mb-6 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <fieldset disabled={exporting}><legend className="text-sm font-semibold text-[#263c57]">Período do resumo, da tabela e do CSV</legend><p id="report-period-help" className="mt-2 text-xs leading-6 text-[#607189]">Até um ano de calendário. Datas interpretadas no horário de Brasília (America/Sao_Paulo).</p><div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label htmlFor="report-start" className={fieldLabel}>Data inicial<input id="report-start" type="date" required value={draft.start_date} onChange={event => edit('start_date', event.target.value)} aria-invalid={!!periodError} aria-describedby={`report-period-help${periodError ? ' report-period-error' : ''}`} className={`${fieldClass} mt-2 min-w-0`} /></label>
        <label htmlFor="report-end" className={fieldLabel}>Data final<input id="report-end" type="date" required value={draft.end_date} onChange={event => edit('end_date', event.target.value)} aria-invalid={!!periodError} aria-describedby={`report-period-help${periodError ? ' report-period-error' : ''}`} className={`${fieldClass} mt-2 min-w-0`} /></label>
      </div></fieldset>
      {periodError && <p id="report-period-error" role="alert" className="mt-3 text-sm text-red-800">{periodError}</p>}
      <fieldset className="mt-5 border-t border-[#e9edf3] pt-5"><legend className="text-sm font-semibold text-[#263c57]">Filtros adicionais — somente tabela e CSV</legend>
        {!options && <p role="status" className="mt-3 text-xs text-[#607189]">Carregando opções...</p>}
        {options?.error && <div role="alert" className="mt-3 text-sm text-red-800">{options.error} <button type="button" className={buttonClass} onClick={retry}>Recarregar opções</button></div>}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {select('report-assignee', 'Responsável atual', 'assigned_to', <><option value="">Todos</option><option value="unassigned">Sem responsável</option>{options?.data?.assignees.map(owner => <option key={owner.id} value={owner.id}>{owner.name}{!owner.is_active ? ' · Desativado' : ''}{owner.role !== 'technician' ? ' · Outro perfil atual' : ''}</option>)}</>)}
          {select('report-category', 'Categoria atual', 'category_id', <><option value="">Todas</option>{options?.data?.categories.map(category => <option key={category.id} value={category.id}>{category.name}{!category.is_active ? ' · Inativa' : ''}</option>)}</>)}
          {select('report-priority', 'Prioridade atual', 'priority', <><option value="">Todas</option>{options?.data?.priorities.map(code => <option key={code} value={code}>{ticketPriorityLabels[code as keyof typeof ticketPriorityLabels] ?? code}</option>)}</>)}
          {select('report-status', 'Status atual', 'status', <><option value="">Todos</option>{options?.data?.statuses.map(status => <option key={status.id} value={status.code}>{status.name}</option>)}</>)}
          {select('report-per-page', 'Chamados por página', 'per_page', <>{[15, 30, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</>)}
        </div>
      </fieldset>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-xs text-[#607189]">{dirty ? 'Há filtros em edição. Aplique para atualizar os resultados e exportar.' : 'Os cartões consideram apenas o período; filtros adicionais não alteram seus valores.'}</p><button type="submit" disabled={exporting} className={`${primaryButtonClass} w-full sm:w-auto`}>Aplicar filtros</button></div>
    </form>
    <section aria-label="Movimentos do período" aria-busy={!summary}>
      <h2 className="mb-3 text-sm font-semibold text-[#263c57]">Movimentos do período</h2>
      <p className="mb-4 text-xs text-[#607189]">Período aplicado: {applied.start_date.split('-').reverse().join('/')} a {applied.end_date.split('-').reverse().join('/')} · Horário de Brasília.</p>
      <div className="grid gap-4 sm:grid-cols-3"><MetricCard label="Criados no período" description="Data de abertura no intervalo" icon="ticket" value={summary?.data?.data.movements.created} loading={!summary} /><MetricCard label="Com resolução registrada" description="Chamados distintos, incluindo os reabertos" icon="check" value={summary?.data?.data.movements.resolved_distinct} loading={!summary} /><MetricCard label="Fechados no período" description="Data de fechamento no intervalo" icon="clock" value={summary?.data?.data.movements.closed} loading={!summary} /></div>
      <p className="my-3 text-xs leading-6 text-[#607189]">Cada movimento usa sua própria data. Resoluções contam eventos registrados; não representam apenas os chamados atualmente resolvidos.</p>
      {!summary && <p role="status" className="mb-5 text-sm text-[#607189]">Carregando resumo...</p>}
      {summary?.error && <div role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{summary.error} <button type="button" className={buttonClass} onClick={retry}>Recarregar resumo</button></div>}
    </section>
    {summary?.data && <>
      <section aria-labelledby="report-cohort-title" className="my-6"><h2 id="report-cohort-title" className="text-sm font-semibold text-[#263c57]">Situação atual dos criados no período</h2><p className="mt-2 mb-4 text-xs leading-6 text-[#607189]">{summary.data.data.cohort.total.toLocaleString('pt-BR')} chamados · {summary.data.data.cohort.unassigned.count.toLocaleString('pt-BR')} sem responsável, incluindo estados finais e cancelados. Não é uma reconstrução do estado no fim do período.</p>
        <div className="grid items-start gap-4 lg:grid-cols-3"><ReportDistribution title="Por status atual" items={summary.data.data.cohort.by_status.map(r => ({ label: r.name, count: r.count }))} /><ReportDistribution title="Por categoria atual" items={summary.data.data.cohort.by_category.map(r => ({ label: `${r.name}${!r.is_active ? ' · Inativa' : ''}`, count: r.count }))} /><ReportDistribution title="Por prioridade atual" items={summary.data.data.cohort.by_priority.map(r => ({ label: ticketPriorityLabels[r.code as keyof typeof ticketPriorityLabels] ?? r.code, count: r.count }))} /></div>
      </section>
      <section aria-labelledby="report-sla-title" className="mb-6"><h2 id="report-sla-title" className="mb-3 text-sm font-semibold text-[#263c57]">SLA dos chamados criados no período</h2><p className="mb-4 text-xs leading-6 text-[#607189]">Prazos atualmente registrados, que podem ter sido recalculados após mudanças de prioridade. Tempo corrido, sem pausa ao aguardar o solicitante.</p><div className="grid gap-4 lg:grid-cols-2"><ReportSlaIndicator title="Primeira resposta" data={summary.data.data.sla.first_response} /><ReportSlaIndicator title="Resolução" data={summary.data.data.sla.resolution} /></div><p className="mt-3 text-xs text-[#607189]">Referência: <TicketDate value={summary.data.meta.as_of} />.</p></section>
    </>}
    <ReportTicketsTable response={table?.data ?? null} loading={!table} error={table?.error ?? null} disabled={exporting || dirty} headingRef={tableHeading} onRetry={retry} onPage={page => { if (!dirty && !exporting) { focusNext.current = true; setApplied(current => ({ ...current, page })) } }} />
    <p className="mt-4 text-xs leading-6 text-[#607189]">CSV em UTF-8, separador ponto e vírgula, com datas UTC. Não remova os prefixos de proteção das células ao abrir ou converter a planilha.</p>
  </>
}
