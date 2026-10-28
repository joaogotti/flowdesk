import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const counts = { total: 21, open: 4, in_progress: 5, waiting_requester: 3, resolved: 2, closed: 6, cancelled: 1, unassigned: 7 }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('dashboard usa somente GET de estatísticas, com cookies, Accept e cancelamento', async () => {
  const controller = new AbortController()
  let calls = 0
  const load = runtime(async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/api/dashboard/stats')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.signal, controller.signal)
    assert.equal(options.headers.get('Accept'), 'application/json')
    assert.equal(options.body, undefined)
    return json({ data: { ...counts, secret: 'não exibir' }, secret: 'não exibir' })
  })
  const { getDashboardStats } = await load('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardStats(controller.signal))), counts)
  assert.equal(calls, 1)
})

test('dashboard aceita oito zeros reais sem substituir por dados fictícios', async () => {
  const zeros = Object.fromEntries(Object.keys(counts).map(key => [key, 0]))
  const { getDashboardStats } = await runtime(async () => json({ data: zeros }))('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardStats())), zeros)
})

test('dashboard rejeita envelopes incompletos, arrays e contagens inválidas em todos os campos', async () => {
  let response
  const { getDashboardStats } = await runtime(async () => json(response))('services/dashboard')
  for (const invalid of [null, [], {}, { data: null }, { data: [] }, { data: 'invalid' }]) {
    response = invalid
    await assert.rejects(getDashboardStats(), /formato esperado/)
  }
  for (const key of Object.keys(counts)) {
    response = { data: { ...counts } }
    delete response.data[key]
    await assert.rejects(getDashboardStats(), /formato esperado/)
    for (const invalid of [null, '1', -1, 1.5, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      response = { data: { ...counts, [key]: invalid } }
      await assert.rejects(getDashboardStats(), /formato esperado/)
    }
  }
})

for (const status of [201, 202, 204, 205]) test(`dashboard não considera HTTP ${status} como confirmação`, async () => {
  const { getDashboardStats } = await runtime(async () => [204, 205].includes(status) ? new Response(null, { status }) : json({ data: counts }, status))('services/dashboard')
  await assert.rejects(getDashboardStats())
})

for (const status of [401, 403, 404, 419, 422, 500, 503]) test(`dashboard preserva HTTP ${status} e apresenta mensagem contextual`, async () => {
  const load = runtime(async () => json({}, status))
  const { ApiError } = await load('services/api')
  const { getDashboardStats, getDashboardErrorMessage } = await load('services/dashboard')
  await assert.rejects(getDashboardStats(), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, status)
    assert.match(getDashboardErrorMessage(error), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
    return true
  })
})

test('falhas de rede, JSON e cancelamento não produzem estatísticas', async () => {
  for (const fetch of [async () => { throw TypeError('Offline') }, async () => new Response('{'), async () => { throw new DOMException('Aborted', 'AbortError') }]) {
    const { getDashboardStats, getDashboardErrorMessage } = await runtime(fetch)('services/dashboard')
    await assert.rejects(getDashboardStats(), error => {
      assert.match(getDashboardErrorMessage(error), /Não foi possível carregar os indicadores/)
      return true
    })
  }
})
