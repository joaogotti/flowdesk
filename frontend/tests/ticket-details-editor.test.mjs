import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('permissões: papel, responsável e todos os estados do chamado', async () => {
  const load = runtime(() => { throw Error('Transporte inesperado') })
  const { canEditTicketDetails } = await load('utils/ticket-details')
  for (const status of ['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled', 'unknown']) {
    for (const role of ['admin', 'technician', 'requester', 'unknown']) for (const assigned of [null, 8, 9]) {
      const editable = ['open', 'in_progress', 'waiting_requester'].includes(status)
      assert.equal(canEditTicketDetails({ id: 8, role }, { status: { code: status }, assignee: assigned ? { id: assigned } : null }), editable && (role === 'admin' || (role === 'technician' && assigned === 8)))
    }
  }
})

test('payload contém apenas as diferenças em relação à abertura da edição', async () => {
  const load = runtime(() => { throw Error('Transporte inesperado') })
  const { getTicketDetailsChanges } = await load('utils/ticket-details')
  const original = { categoryId: 1, priority: 'medium' }
  for (const [categoryId, priority, expected] of [
    [1, 'medium', {}], [2, 'medium', { category_id: 2 }],
    [1, 'high', { priority: 'high' }], [2, 'urgent', { category_id: 2, priority: 'urgent' }],
  ]) assert.deepEqual(JSON.parse(JSON.stringify(getTicketDetailsChanges(original, categoryId, priority))), expected)
})

for (const input of [{ category_id: 2 }, { priority: 'low' }, { priority: 'medium' }, { priority: 'high' }, { priority: 'urgent' }, { category_id: 2, priority: 'high' }]) test(`PATCH parcial/junto ${JSON.stringify(input)}: cookies, CSRF e projeção`, async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : json({})
  })
  const { updateTicketDetails } = await load('services/tickets')
  await updateTicketDetails('8', { ...input, status: 'closed', actor_id: 99, sla_policy_id: 1 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/tickets/8/details')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(calls[1].options.body), input)
})

test('nenhuma rede para IDs inválidos, alterações vazias ou valores inválidos', async () => {
  let calls = 0
  const load = runtime(async () => { calls++; throw Error('Transporte inesperado') })
  const { updateTicketDetails } = await load('services/tickets')
  for (const id of ['0', '-1', 'abc', '9223372036854775808']) await assert.rejects(updateTicketDetails(id, { priority: 'high' }))
  for (const input of [{}, { status: 'open' }, { category_id: null }, { category_id: 0 }, { category_id: -1 }, { category_id: '2' }, { category_id: 1.5 }, { priority: null }, { priority: '' }, { priority: 'HIGH' }, { priority: 'constructor' }]) await assert.rejects(updateTicketDetails('8', input))
  assert.equal(calls, 0)
})

for (const status of [201, 202, 204]) test(`edição não aceita HTTP ${status} como confirmação`, async () => {
  const load = runtime(async url => url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : status === 204 ? new Response(null, { status }) : json({}, status))
  const { updateTicketDetails } = await load('services/tickets')
  await assert.rejects(updateTicketDetails('8', { priority: 'high' }))
})

for (const status of [401, 403, 404, 409, 419, 422, 500]) test(`edição trata HTTP ${status} sem repetir PATCH`, async () => {
  let patches = 0
  const load = runtime(async url => {
    if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    patches++
    return json({ errors: { category_id: ['Categoria indisponível.'], priority: ['Prioridade indisponível.'] } }, status)
  })
  const { updateTicketDetails, getTicketDetailsUpdateErrorMessage } = await load('services/tickets')
  await assert.rejects(updateTicketDetails('8', { category_id: 2, priority: 'high' }), error => {
    assert.equal(error.status, status)
    assert.ok(getTicketDetailsUpdateErrorMessage(error).length > 0)
    if (status === 422) assert.deepEqual(Array.from(error.validationErrors.category_id), ['Categoria indisponível.'])
    return true
  })
  assert.equal(patches, 1)
})

for (const phase of ['csrf', 'patch']) test(`falha de rede em ${phase} mantém erro sem retry automático`, async () => {
  let calls = 0
  const load = runtime(async url => {
    calls++
    if (phase === 'patch' && url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    throw TypeError('Offline')
  })
  const { updateTicketDetails, getTicketDetailsUpdateErrorMessage } = await load('services/tickets')
  await assert.rejects(updateTicketDetails('8', { priority: 'high' }), error => {
    assert.match(getTicketDetailsUpdateErrorMessage(error), /seleções foram mantidas/)
    return true
  })
  assert.equal(calls, phase === 'csrf' ? 1 : 2)
})
