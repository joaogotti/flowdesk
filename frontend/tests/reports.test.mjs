import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'
import { reportFixtures } from './helpers/report-fixtures.mjs'

const period = { start_date: '2026-10-01', end_date: '2026-10-30' }
const filters = { ...period, assigned_to: '8', category_id: '1', priority: 'urgent', status: 'open', page: 2, per_page: 15 }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('default period is thirty São Paulo calendar days at UTC midnight and month/year boundaries', async () => {
  const { defaultReportFilters } = await runtime(() => {})('utils/reports')
  const f = defaultReportFilters(new Date('2026-10-30T02:00:00Z'))
  assert.equal(f.end_date, '2026-10-29'); assert.equal(f.start_date, '2026-09-30')
  assert.equal(defaultReportFilters(new Date('2026-01-01T02:00:00Z')).end_date, '2025-12-31')
})
test('period validation matches calendar year, leap days, missing dates and reversed bounds', async () => {
  const { validateReportPeriod } = await runtime(() => {})('utils/reports')
  for (const [start_date, end_date] of [['2024-01-01','2024-12-31'],['2026-10-01','2026-10-01'],['2018-11-04','2018-11-04']]) assert.equal(validateReportPeriod({start_date,end_date}),null)
  for (const [start_date, end_date] of [['2026-02-30','2026-03-01'],['',''],['2026-10-02','2026-10-01'],['2026-01-01','2027-01-01'],['2024-01-01','2025-01-01']]) assert.ok(validateReportPeriod({start_date,end_date}))
})

test('summary sends dates only; table retains all filters/pagination and cookies', async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    const u = new URL(url); calls.push({u,options})
    const f = reportFixtures(period, Object.fromEntries(u.searchParams))
    return json(u.pathname.endsWith('/summary') ? f.summary : f.table)
  })
  const service = await load('services/reports')
  const s = await service.getReportSummary(filters)
  assert.equal(s.data.sla.resolution.compliance_rate, null)
  assert.deepEqual([...calls[0].u.searchParams.keys()], ['start_date','end_date'])
  const t = await service.getReportTickets(filters)
  assert.equal(t.current_page, 2); assert.equal(t.data[0].id, 985)
  assert.equal(calls[1].u.searchParams.get('assigned_to'),'8')
  for (const {options} of calls) { assert.equal(options.credentials,'include'); assert.equal(options.cache,'no-store') }
})

test('catalog accepts inactive categories and historical owners with changed roles', async () => {
  const service = await runtime(async () => json(reportFixtures(period).options))('services/reports')
  const options = await service.getReportOptions(period)
  assert.equal(options.assignees[0].is_active,false); assert.equal(options.assignees[0].role,'admin')
  assert.equal(options.categories[0].is_active,false)
})

for (const mutation of ['sum','rate','denominator','dates','state']) test(`summary rejects inconsistent ${mutation}`, async () => {
  const f = reportFixtures(period)
  if (mutation==='sum') f.summary.data.cohort.by_status[0].count=100
  if (mutation==='rate') f.summary.data.sla.resolution.compliance_rate=0
  if (mutation==='denominator') f.summary.data.sla.first_response.compliance_denominator=3
  if (mutation==='dates') f.summary.meta.start_date='2020-01-01'
  if (mutation==='state') f.summary.data.sla.first_response.met=-1
  await assert.rejects((await runtime(async()=>json(f.summary))('services/reports')).getReportSummary(period))
})

test('table rejects wrong filters, wrong page and invalid SLA without following server URLs', async () => {
  for (const what of ['filters','page','sla']) {
    const f = reportFixtures(period,filters)
    if (what==='filters') f.table.meta.filters.assigned_to=9
    if (what==='page') f.table.current_page=1
    if (what==='sla') f.table.data[0].sla.first_response='invented'
    await assert.rejects((await runtime(async()=>json(f.table))('services/reports')).getReportTickets(filters))
  }
})

test('CSV uses existing binary API, preserves filters and sends no mutation or CSRF initialization', async () => {
  const calls=[]
  const service=await runtime(async(url,options)=>{calls.push({url,options});return new Response('\uFEFFID;Título\r\n1;teste',{headers:{'Content-Type':'text/csv; charset=UTF-8'}})})('services/reports')
  const file=await service.getReportCsv(filters)
  assert.ok(file instanceof Blob);assert.equal(calls.length,1)
  const u=new URL(calls[0].url)
  assert.equal(u.pathname,'/api/reports/tickets/export');assert.equal(u.searchParams.get('page'),'2');assert.equal(u.searchParams.get('priority'),'urgent')
  assert.equal(calls[0].options.credentials,'include');assert.equal(calls[0].options.method,'GET')
})

for(const [status,code,fragment] of [[401,'session_revoked','revogada'],[401,undefined,'expirou'],[403,undefined,'administradores'],[419,undefined,'validar'],[422,'export_limit_exceeded','5.000'],[422,undefined,'Filtros inválidos'],[429,undefined,'Muitas'],[503,'report_unavailable','indisponíveis']]) test(`HTTP ${status}/${code} is safe and does not retry`,async()=>{
  let calls=0
  const load=runtime(async()=>{calls++;return json({code,message:'/private/secret'},status)})
  const service=await load('services/reports')
  await assert.rejects(service.getReportCsv(filters),cause=>{assert.ok(service.getReportError(cause).includes(fragment));assert.ok(!service.getReportError(cause).includes('/private'));return true})
  assert.equal(calls,1)
})

test('binary export errors distinguish session revocation from forbidden operations',async()=>{
  let status=403, events=0
  const load=runtime(async()=>json({code:'session_revoked'},status))
  const api=await load('services/api');api.onSessionRevoked(()=>events++)
  const service=await load('services/reports')
  await assert.rejects(service.getReportCsv(filters));assert.equal(events,0)
  status=401;await assert.rejects(service.getReportCsv(filters));assert.equal(events,1)
})
test('invalid periods never access API; network and invalid CSV are recoverable',async()=>{
  let calls=0
  const service=await runtime(async()=>{calls++;throw TypeError('Offline')})('services/reports')
  await assert.rejects(service.getReportSummary({...period,start_date:''}));assert.equal(calls,0)
  await assert.rejects(service.getReportTickets(filters));assert.equal(calls,1)
  const invalid=await runtime(async()=>json({private:'secret'}))('services/reports')
  await assert.rejects(invalid.getReportCsv(filters))
})
test('hash navigation recognizes reports explicitly',async()=>{
  const {parseWorkspaceHash}=await runtime(()=>{})('utils/navigation')
  assert.equal(parseWorkspaceHash('#/relatorios').page,'reports')
})
