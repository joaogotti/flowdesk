import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const response = assignedTo => ({ id: 8, assignee: assignedTo === null ? null : { id: assignedTo, name: 'Técnico de teste' }, updated_at: '2026-10-22T00:00:00Z' })

test('técnicos: GET autenticado, sinal, projeção e lista vazia', async () => {
  const controller = new AbortController()
  let data = { data: [{ id: 8, name: 'Técnico de teste', email: 'oculto@example.invalid' }] }
  const load = runtime(async (url, options) => {
    assert.equal(url, 'http://localhost:8000/api/technicians')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.signal, controller.signal)
    return json(data)
  })
  const { getTechnicians } = await load('services/technicians')
  assert.deepEqual(JSON.parse(JSON.stringify(await getTechnicians(controller.signal))), [{ id: 8, name: 'Técnico de teste' }])
  data = { data: [] }
  assert.equal((await getTechnicians(controller.signal)).length, 0)
  for (const invalid of [{}, { data: null }, { data: [{ id: '8', name: 'Inválido' }] }, { data: [{ id: 0, name: 'Inválido' }] }]) {
    data = invalid
    await assert.rejects(getTechnicians(controller.signal), /formato esperado/)
  }
})

for (const assignedTo of [8, 9, null]) test(`atribuição ${assignedTo}: PATCH com cookies, CSRF e somente assigned_to`, async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : json(response(assignedTo))
  })
  const { updateTicketAssignment } = await load('services/tickets')
  const result = await updateTicketAssignment('8', { assigned_to: assignedTo, status_id: 6, role: 'admin' })
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/tickets/8/assignment')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(calls[1].options.body), { assigned_to: assignedTo })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), response(assignedTo))
})

test('IDs inválidos não geram CSRF nem PATCH', async () => {
  let calls = 0
  const load = runtime(async () => { calls++; throw Error('Sem rede') })
  const { updateTicketAssignment } = await load('services/tickets')
  await assert.rejects(updateTicketAssignment('0', { assigned_to: 8 }))
  for (const assigned_to of [0, -1, 1.5, '8', undefined]) await assert.rejects(updateTicketAssignment('8', { assigned_to }))
  assert.equal(calls, 0)
})

test('atribuição exige HTTP 200 e resposta correspondente', async () => {
  let status = 201
  let data = response(8)
  const load = runtime(async url => url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : status === 204 ? new Response(null, { status }) : json(data, status))
  const { updateTicketAssignment } = await load('services/tickets')
  for (const value of [201, 202, 204]) {
    status = value
    await assert.rejects(updateTicketAssignment('8', { assigned_to: 8 }))
  }
  status = 200
  for (const invalid of [{}, { ...response(8), id: 9 }, response(9), { ...response(8), updated_at: null }]) {
    data = invalid
    await assert.rejects(updateTicketAssignment('8', { assigned_to: 8 }))
  }
})

for (const status of [401, 403, 404, 409, 419, 422, 500]) test(`atribuição preserva HTTP ${status} e mensagem clara`, async () => {
  let patches = 0
  const load = runtime(async url => {
    if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    patches++
    return json({ errors: { assigned_to: ['Selecione um técnico ativo válido.'] } }, status)
  })
  const { updateTicketAssignment, getTicketAssignmentErrorMessage } = await load('services/tickets')
  await assert.rejects(updateTicketAssignment('8', { assigned_to: 8 }), error => {
    assert.equal(error.status, status)
    assert.ok(getTicketAssignmentErrorMessage(error).length > 0)
    if (status === 422) assert.equal(getTicketAssignmentErrorMessage(error), 'Selecione um técnico ativo válido.')
    return true
  })
  assert.equal(patches, 1)
})

test('erro de CSRF impede PATCH e falha de conexão não simula sucesso', async () => {
  let calls = 0
  const load = runtime(async () => { calls++; throw TypeError('offline') })
  const { updateTicketAssignment, getTicketAssignmentErrorMessage } = await load('services/tickets')
  await assert.rejects(updateTicketAssignment('8', { assigned_to: 8 }), error => {
    assert.match(getTicketAssignmentErrorMessage(error), /conexão/)
    return true
  })
  assert.equal(calls, 1)
})

for (const status of [401, 403, 500]) test(`carregamento de técnicos trata HTTP ${status}`, async () => {
  const load = runtime(async () => json({}, status))
  const { getTechnicians, getTechniciansErrorMessage } = await load('services/technicians')
  await assert.rejects(getTechnicians(), error => {
    assert.equal(error.status, status)
    assert.ok(getTechniciansErrorMessage(error).length > 0)
    return true
  })
})
