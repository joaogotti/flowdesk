import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const transitions = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['waiting_requester', 'resolved', 'cancelled'],
  waiting_requester: ['in_progress', 'cancelled'],
  resolved: ['in_progress', 'closed'], closed: [], cancelled: [],
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('matriz completa de transições e permissões conhecidas', async () => {
  const load = runtime(() => { throw Error('Nenhuma rede esperada') })
  const { getTicketStatusTransitions, canUpdateTicketStatus } = await load('utils/ticket-status')
  for (const [from, targets] of Object.entries(transitions)) {
    assert.deepEqual(Array.from(getTicketStatusTransitions(from)), targets)
  }
  for (const unknown of ['unknown', '__proto__', 'constructor', '']) assert.equal(getTicketStatusTransitions(unknown).length, 0)
  for (const assignee of [null, { id: 8 }, { id: 9 }]) {
    assert.equal(canUpdateTicketStatus({ id: 8, role: 'admin' }, assignee), true)
    assert.equal(canUpdateTicketStatus({ id: 8, role: 'technician' }, assignee), assignee?.id === 8)
    assert.equal(canUpdateTicketStatus({ id: 8, role: 'requester' }, assignee), false)
    assert.equal(canUpdateTicketStatus({ id: 8, role: 'unknown' }, assignee), false)
  }
})

for (const status of Object.keys(transitions)) test(`PATCH ${status}: cookies, CSRF e payload somente com status`, async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : json({})
  })
  const { updateTicketStatus } = await load('services/tickets')
  await updateTicketStatus('8', { status, actor_id: 99, resolved_at: 'forjado' })
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/tickets/8/status')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(calls[1].options.body), { status })
})

test('IDs e códigos inválidos não iniciam transporte', async () => {
  let calls = 0
  const load = runtime(async () => { calls++; throw Error('Transporte inesperado') })
  const { updateTicketStatus } = await load('services/tickets')
  for (const id of ['0', '-1', 'abc', '9223372036854775808']) await assert.rejects(updateTicketStatus(id, { status: 'in_progress' }))
  for (const status of ['unknown', '', 'constructor', null, 1]) await assert.rejects(updateTicketStatus('8', { status }))
  assert.equal(calls, 0)
})

for (const status of [201, 202, 204]) test(`HTTP ${status} não confirma sucesso`, async () => {
  const load = runtime(async url => url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : status === 204 ? new Response(null, { status }) : json({}, status))
  const { updateTicketStatus } = await load('services/tickets')
  await assert.rejects(updateTicketStatus('8', { status: 'resolved' }))
})

for (const status of [401, 403, 404, 409, 419, 422, 500]) test(`HTTP ${status}: erro preservado e mensagem orienta usuário`, async () => {
  let patches = 0
  const load = runtime(async url => {
    if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    patches++
    return json({ errors: { status: ['Status indisponível no teste.'] } }, status)
  })
  const { updateTicketStatus, getTicketStatusErrorMessage } = await load('services/tickets')
  await assert.rejects(updateTicketStatus('8', { status: 'resolved' }), error => {
    assert.equal(error.status, status)
    assert.ok(getTicketStatusErrorMessage(error).length > 0)
    if (status === 422) assert.equal(getTicketStatusErrorMessage(error), 'Status indisponível no teste.')
    return true
  })
  assert.equal(patches, 1)
})

for (const phase of ['csrf', 'patch']) test(`rede falha em ${phase}: não há retry automático`, async () => {
  let calls = 0
  const load = runtime(async url => {
    calls++
    if (phase === 'patch' && url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    throw TypeError('Offline')
  })
  const { updateTicketStatus, getTicketStatusErrorMessage } = await load('services/tickets')
  await assert.rejects(updateTicketStatus('8', { status: 'resolved' }), error => {
    assert.match(getTicketStatusErrorMessage(error), /seleção foi mantida/)
    return true
  })
  assert.equal(calls, phase === 'csrf' ? 1 : 2)
})
