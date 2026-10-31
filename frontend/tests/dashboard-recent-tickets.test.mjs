import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const ticket = () => ({ id: 9, title: 'Problema de acesso', status: { code: 'open', name: 'Aberto' }, assignee: null, updated_at: '2026-10-23T01:30:00.000000Z' })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('recentes: GET com cookies e cancelamento preserva ordem e projeta somente os campos públicos', async () => {
  const signal = new AbortController().signal
  const data = [ticket(), { ...ticket(), id: 47, assignee: { id: 8, name: 'Técnico', email: 'private' }, status: { id: 42, code: 'in_progress', name: 'Em andamento' }, comments: ['private'] }]
  let calls = 0
  const { getRecentTickets } = await runtime(async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/api/dashboard/recent-tickets')
    assert.equal(options.credentials, 'include')
    assert.equal(options.method, 'GET')
    assert.equal(options.headers.get('Accept'), 'application/json')
    assert.equal(options.body, undefined)
    assert.equal(options.signal.aborted, false)
    return json({ data })
  })('services/dashboard')
  const result = JSON.parse(JSON.stringify(await getRecentTickets(signal)))
  assert.deepEqual(result, [ticket(), { ...ticket(), id: 47, assignee: { id: 8, name: 'Técnico' }, status: { code: 'in_progress', name: 'Em andamento' } }])
  assert.equal(calls, 1)
})

test('recentes: aceita lista vazia e cinco itens, rejeita mais de cinco e IDs duplicados', async () => {
  let data = []
  const { getRecentTickets } = await runtime(async () => json({ data }))('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getRecentTickets())), [])
  data = Array.from({ length: 5 }, (_, i) => ({ ...ticket(), id: i + 1 }))
  assert.equal((await getRecentTickets()).length, 5)
  data.push({ ...ticket(), id: 6 })
  await assert.rejects(getRecentTickets(), /formato esperado/)
  data = [ticket(), ticket()]
  await assert.rejects(getRecentTickets(), /formato esperado/)
})

test('recentes: valida envelope, campos, identificadores, responsável e data antes de renderizar', async () => {
  let response
  const { getRecentTickets } = await runtime(async () => json(response))('services/dashboard')
  for (const invalid of [null, [], {}, { data: null }, { data: {} }]) {
    response = invalid
    await assert.rejects(getRecentTickets(), /formato esperado/)
  }
  for (const field of Object.keys(ticket())) {
    const row = ticket()
    delete row[field]
    response = { data: [row] }
    await assert.rejects(getRecentTickets(), /formato esperado/)
  }
  for (const patch of [
    { id: 0 }, { id: -1 }, { id: '9' }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { title: null }, { status: null }, { status: { code: 'open' } }, { status: { name: 'Aberto' } },
    { assignee: {} }, { assignee: { id: '8', name: 'Técnico' } }, { assignee: { id: 0, name: 'Técnico' } },
    { assignee: { id: 8, name: null } }, { updated_at: null }, { updated_at: '' }, { updated_at: 'not-a-date' },
  ]) {
    response = { data: [{ ...ticket(), ...patch }] }
    await assert.rejects(getRecentTickets(), /formato esperado/)
  }
})

for (const status of [401, 403, 404, 419, 422, 500, 503]) test(`recentes: HTTP ${status} e mensagem contextual`, async () => {
  const load = runtime(async () => json({}, status))
  const { ApiError } = await load('services/api')
  const { getRecentTickets, getRecentTicketsErrorMessage } = await load('services/dashboard')
  await assert.rejects(getRecentTickets(), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, status)
    assert.match(getRecentTicketsErrorMessage(error), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
    return true
  })
})

for (const status of [201, 202, 204, 205]) test(`recentes: HTTP ${status} não confirma consulta`, async () => {
  const { getRecentTickets } = await runtime(async () => [204, 205].includes(status) ? new Response(null, { status }) : json({ data: [] }, status))('services/dashboard')
  await assert.rejects(getRecentTickets())
})

test('recentes: rede, JSON inválido e cancelamento não fabricam chamados', async () => {
  for (const fetch of [async () => { throw TypeError('Offline') }, async () => new Response('{'), async () => { throw new DOMException('Aborted', 'AbortError') }]) {
    const { getRecentTickets } = await runtime(fetch)('services/dashboard')
    await assert.rejects(getRecentTickets())
  }
})
