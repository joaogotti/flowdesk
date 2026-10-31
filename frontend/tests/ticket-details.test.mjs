import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

// Dados de contrato usados apenas no transporte de teste; nunca alimentam a aplicação.
const payload = () => ({
  id: 8, title: 'Título', description: 'Descrição\ncompleta', priority: 'medium',
  requester: { id: 1, name: 'Solicitante' }, assignee: null,
  category: { id: 3, name: 'Rede' }, status: { id: 1, code: 'open', name: 'Aberto' },
  created_at: '2026-10-21T20:43:42.000000Z', updated_at: '2026-10-21T20:43:42.000000Z',
  first_response_due_at: '2026-10-22T00:43:42.000000Z', resolution_due_at: '2026-10-22T20:43:42.000000Z',
  first_responded_at: null, resolved_at: null, closed_at: null, comments: [],
  activities: [{ id: 2, action: 'created', actor: { id: 1, name: 'Solicitante' }, created_at: '2026-10-21T20:43:42.000000Z' }],
})
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('rotas de listagem, criação e detalhe e rejeição de IDs inválidos', async () => {
  const load = runtime(() => { throw Error('Sem rede') })
  const { parseWorkspaceHash, isValidTicketId } = await load('utils/navigation')
  assert.equal(parseWorkspaceHash('#/chamados').page, 'tickets')
  assert.equal(parseWorkspaceHash('#/chamados/novo').page, 'new-ticket')
  assert.equal(parseWorkspaceHash('#/visao-geral').page, 'overview')
  assert.equal(parseWorkspaceHash('#/chamados/8').ticketId, '8')
  assert.equal(isValidTicketId('9223372036854775807'), true)
  for (const id of ['', '0', '-1', '01', '8.1', 'abc', '8/extra', '8?role=admin', '9223372036854775808', '9'.repeat(100)]) {
    assert.equal(isValidTicketId(id), false, id)
    assert.equal(parseWorkspaceHash(`#/chamados/${id}`).page, 'ticket-details')
    assert.equal(parseWorkspaceHash(`#/chamados/${id}`).ticketId, null)
  }
})

test('IDs inválidos não geram requisições de detalhe', async () => {
  let calls = 0
  const load = runtime(() => { calls++; throw Error('Não deveria consultar') })
  const { getTicketDetails } = await load('services/tickets')
  for (const id of ['0', '-1', 'novo', '8/extra', '9223372036854775808']) await assert.rejects(getTicketDetails(id), /inválido/)
  assert.equal(calls, 0)
})

test('detalhe usa GET com cookies e sinal de cancelamento e mantém nulos', async () => {
  const controller = new AbortController()
  let calls = 0
  const load = runtime(async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/api/tickets/8')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.signal.aborted, false)
    assert.equal(options.headers.has('X-XSRF-TOKEN'), false)
    return json(payload())
  })
  const { getTicketDetails } = await load('services/tickets')
  const ticket = await getTicketDetails('8', controller.signal)
  assert.deepEqual(JSON.parse(JSON.stringify(ticket)), payload())
  assert.equal(ticket.assignee, null)
  assert.equal(calls, 1)
})

test('comentários preservam flag opcional; atividades nulas e desconhecidas são mantidas sem changes', async () => {
  const data = payload()
  data.requester.email = 'nao-exibir@example.invalid'
  data.comments = [
    { id: 1, author: { id: 1, name: 'Autor', password: 'nao-exibir' }, body: 'Público', created_at: data.created_at },
    { id: 2, author: { id: 1, name: 'Autor' }, body: 'Interno', is_internal: true, created_at: data.created_at },
    { id: 3, author: { id: 1, name: 'Autor' }, body: 'Público', is_internal: false, created_at: data.created_at },
  ]
  data.activities.push({ id: 3, action: 'future_action', actor: null, changes: { secret: 'nao-exibir' }, created_at: data.created_at })
  const load = runtime(async () => json(data))
  const { getTicketDetails } = await load('services/tickets')
  const ticket = await getTicketDetails('8')
  assert.equal(Object.hasOwn(ticket.comments[0], 'is_internal'), false)
  assert.equal(ticket.comments[1].is_internal, true)
  assert.equal(ticket.comments[2].is_internal, false)
  assert.equal(ticket.activities[1].actor, null)
  assert.equal(ticket.activities[1].action, 'future_action')
  assert.equal(JSON.stringify(ticket).includes('nao-exibir'), false)
  assert.equal(JSON.stringify(ticket).includes('changes'), false)
})

test('detalhes do histórico são opcionais, projetados por ação e não substituem os valores atuais', async () => {
  const data = payload()
  data.activities = [
    { id: 1, action: 'assignment_changed', actor: null, created_at: data.created_at, changes: { body: 'privado' }, details: { assignee: { from: null, to: { id: 8, name: null, email: 'privado' } }, secret: 'privado' } },
    { id: 2, action: 'status_changed', actor: null, created_at: data.created_at, details: { status: { from: 'open', to: 'in_progress' } } },
    { id: 3, action: 'details_changed', actor: null, created_at: data.created_at, details: { category: { to: { id: 1, name: 'Hardware' } }, priority: { from: 'medium', to: 'high' } } },
    { id: 4, action: 'comment_added', actor: null, created_at: data.created_at, details: { body: 'privado', assignee: { from: null, to: null } } },
    { id: 5, action: 'details_changed', actor: null, created_at: data.created_at, details: { priority: { from: false, to: 'future-code' } } },
  ]
  const { getTicketDetails } = await runtime(async () => json(data))('services/tickets')
  const ticket = JSON.parse(JSON.stringify(await getTicketDetails('8')))
  assert.deepEqual(ticket.activities.map(a=>a.details), [
    { assignee: { from: null, to: { id: 8, name: null } } }, { status: { from: 'open', to: 'in_progress' } },
    { category: { to: { id: 1, name: 'Hardware' } }, priority: { from: 'medium', to: 'high' } }, undefined, undefined,
  ])
  assert.equal(JSON.stringify(ticket).includes('privado'), false)
  assert.equal(JSON.stringify(ticket).includes('changes'), false)
  assert.equal(ticket.assignee, null)
  assert.equal(ticket.category.name, 'Rede')
  assert.equal(ticket.priority, 'medium')
  assert.equal(ticket.status.code, 'open')
})

test('resposta de outro ID e contrato incompleto são rejeitados', async () => {
  let data = payload()
  const load = runtime(async () => json(data))
  const { getTicketDetails } = await load('services/tickets')
  await assert.rejects(getTicketDetails('9'), /não corresponde/)
  for (const field of ['description', 'updated_at', 'comments', 'activities', 'first_responded_at']) {
    data = payload()
    delete data[field]
    await assert.rejects(getTicketDetails('8'), /formato esperado/)
  }
  data = payload()
  data.comments = [{ id: 1, author: null, body: 'Inválido', created_at: data.created_at }]
  await assert.rejects(getTicketDetails('8'), /formato esperado/)
})

for (const status of [401, 403, 404, 419, 500]) {
  test(`detalhe preserva HTTP ${status} e apresenta mensagem contextual`, async () => {
    const load = runtime(async () => json({ message: 'Erro' }, status))
    const { getTicketDetails, getTicketDetailsErrorMessage } = await load('services/tickets')
    await assert.rejects(getTicketDetails('8'), (error) => {
      assert.equal(error.status, status)
      assert.ok(getTicketDetailsErrorMessage(error).length > 0)
      if (status === 404) assert.match(getTicketDetailsErrorMessage(error), /não existe ou não está disponível/)
      return true
    })
  })
}

test('falha de conexão não produz dados nem sucesso', async () => {
  const load = runtime(async () => { throw TypeError('offline') })
  const { getTicketDetails, getTicketDetailsErrorMessage } = await load('services/tickets')
  await assert.rejects(getTicketDetails('8'), (error) => {
    assert.match(getTicketDetailsErrorMessage(error), /conexão/)
    return true
  })
})

test('datas usam pt-BR em America/Sao_Paulo, inclusive na mudança de dia UTC', async () => {
  const load = runtime(() => {})
  const { formatTicketDate } = await load('utils/ticket-dates')
  assert.equal(formatTicketDate('2026-10-22T00:43:42.000000Z'), '21/10/2026, 21:43')
})

test('SLA distingue pendência, atraso, realização efetiva e encerramento sem inferir datas', async () => {
  const load = runtime(() => {})
  const { getDeadlineState } = await load('utils/ticket-dates')
  const base = { createdAt: '2026-10-21T10:00:00Z', dueAt: '2026-10-21T14:00:00Z', occurredAt: null, closedAt: null, resolvedAt: null, status: 'open', now: Date.parse('2026-10-21T15:00:00Z') }
  assert.equal(getDeadlineState(base), 'overdue')
  assert.equal(getDeadlineState({ ...base, now: Date.parse('2026-10-21T13:00:00Z') }), 'pending')
  assert.equal(getDeadlineState({ ...base, occurredAt: '2026-10-21T12:00:00Z' }), 'met')
  assert.equal(getDeadlineState({ ...base, occurredAt: '2026-10-21T14:01:00Z' }), 'late')
  assert.equal(getDeadlineState({ ...base, occurredAt: base.dueAt }), 'met')
  for (const status of ['resolved', 'closed', 'cancelled']) assert.equal(getDeadlineState({ ...base, status }), 'inactive')
  assert.equal(getDeadlineState({ ...base, closedAt: '2026-10-21T14:30:00Z' }), 'inactive')
  assert.equal(getDeadlineState({ ...base, resolvedAt: '2026-10-21T14:30:00Z' }), 'inactive')
  assert.equal(getDeadlineState({ ...base, occurredAt: '2026-10-21T12:00:00Z', status: 'closed' }), 'met')
  assert.equal(getDeadlineState({ ...base, occurredAt: '2026-10-21T14:30:00Z', resolvedAt: '2026-10-21T14:30:00Z' }), 'late')
})

test('SLA fica neutro para datas incoerentes ou status desconhecido', async () => {
  const load = runtime(() => {})
  const { getDeadlineState } = await load('utils/ticket-dates')
  const base = { createdAt: '2026-10-21T10:00:00Z', dueAt: '2026-10-21T14:00:00Z', occurredAt: null, closedAt: null, resolvedAt: null, status: 'open', now: Date.parse('2026-10-21T15:00:00Z') }
  for (const patch of [
    { dueAt: 'inválida' }, { dueAt: '2026-10-21T09:00:00Z' }, { now: NaN },
    { occurredAt: '2026-10-21T16:00:00Z' }, { occurredAt: '2026-10-21T09:00:00Z' },
    { closedAt: '2026-10-21T09:00:00Z' }, { resolvedAt: '2026-10-21T16:00:00Z' },
    { occurredAt: '2026-10-21T14:00:00Z', resolvedAt: '2026-10-21T13:00:00Z' }, { status: 'future_status' },
  ]) assert.equal(getDeadlineState({ ...base, ...patch }), 'unknown')
})
