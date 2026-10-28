import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const counts = { on_track: 12, at_risk: 3, overdue: 7 }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('SLA consulta endpoint com sessão e sinal e projeta somente o contrato', async () => {
  const controller = new AbortController()
  let calls = 0
  const { getDashboardSla } = await runtime(async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/api/dashboard/sla')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.headers.get('Accept'), 'application/json')
    assert.equal(options.signal, controller.signal)
    assert.equal(options.body, undefined)
    return json({ data: { ...counts, internal: 'omit' } })
  })('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardSla(controller.signal))), counts)
  assert.equal(calls, 1)
})

test('SLA aceita zeros reais e rejeita envelopes e cada contagem inválida', async () => {
  let response = { data: { on_track: 0, at_risk: 0, overdue: 0 } }
  const { getDashboardSla } = await runtime(async () => json(response))('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardSla())), response.data)
  for (const invalid of [null, [], {}, { data: null }, { data: [] }, { data: 'invalid' }]) {
    response = invalid
    await assert.rejects(getDashboardSla(), /formato esperado/)
  }
  for (const key of Object.keys(counts)) {
    for (const invalid of [undefined, null, '1', -1, 1.5, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      response = { data: { ...counts, [key]: invalid } }
      await assert.rejects(getDashboardSla(), /formato esperado/)
    }
  }
})

for (const status of [201, 202, 204, 205, 401, 403, 404, 419, 422, 500, 503]) test(`SLA trata HTTP ${status} sem fabricar contagens`, async () => {
  const { getDashboardSla, getDashboardSlaErrorMessage } = await runtime(async () => [204, 205].includes(status) ? new Response(null, { status }) : json({ data: counts }, status))('services/dashboard')
  await assert.rejects(getDashboardSla(), error => {
    assert.match(getDashboardSlaErrorMessage(error), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
    return true
  })
})

test('SLA não produz dados em falhas de rede, JSON ou cancelamento', async () => {
  for (const fetch of [async () => { throw TypeError('Offline') }, async () => new Response('{'), async () => { throw new DOMException('Aborted', 'AbortError') }]) {
    const { getDashboardSla } = await runtime(fetch)('services/dashboard')
    await assert.rejects(getDashboardSla())
  }
})
