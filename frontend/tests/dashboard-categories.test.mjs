import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const categories = [{ id: 9, name: 'Rede', count: 3 }, { id: 2, name: 'Hardware', count: 0 }]
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('categorias do Dashboard: GET com cookies, Accept, sinal e projeção preservando a ordem', async () => {
  const controller = new AbortController()
  let calls = 0
  const { getDashboardCategories } = await runtime(async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/api/dashboard/categories')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.headers.get('Accept'), 'application/json')
    assert.equal(options.signal.aborted, false)
    assert.equal(options.body, undefined)
    return json({ data: categories.map(row => ({ ...row, internal: 'omit' })) })
  })('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardCategories(controller.signal))), categories)
  assert.equal(calls, 1)
})

test('categorias: aceita vazio, zeros e muitas categorias sem limitar ou reordenar', async () => {
  let rows = []
  const { getDashboardCategories } = await runtime(async () => json({ data: rows }))('services/dashboard')
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardCategories())), [])
  rows = Array.from({ length: 100 }, (_, i) => ({ id: 100 - i, name: `Categoria ${i}`, count: 0 }))
  assert.deepEqual(JSON.parse(JSON.stringify(await getDashboardCategories())), rows)
})

test('categorias: rejeita envelopes, IDs, nomes, contagens inválidas e IDs duplicados', async () => {
  let response
  const { getDashboardCategories } = await runtime(async () => json(response))('services/dashboard')
  for (const invalid of [null, [], {}, { data: null }, { data: {} }, { data: 'invalid' }, { data: [null] }]) {
    response = invalid
    await assert.rejects(getDashboardCategories(), /formato esperado/)
  }
  const invalidFields = {
    id: [undefined, null, 0, -1, 1.5, '1', true, {}, [], Number.MAX_SAFE_INTEGER + 1],
    name: [undefined, null, '', ' \n ', 5, true, {}, []],
    count: [undefined, null, -1, 1.5, '1', true, {}, [], Number.MAX_SAFE_INTEGER + 1],
  }
  for (const [key, invalidValues] of Object.entries(invalidFields)) for (const value of invalidValues) {
    response = { data: [{ ...categories[0], [key]: value }] }
    await assert.rejects(getDashboardCategories(), /formato esperado/)
  }
  response = { data: [categories[0], categories[0]] }
  await assert.rejects(getDashboardCategories(), /formato esperado/)
})

for (const status of [201, 202, 204, 205, 401, 403, 404, 419, 422, 500, 503]) test(`categorias: HTTP ${status} não produz dados fictícios`, async () => {
  const { getDashboardCategories, getDashboardCategoriesErrorMessage } = await runtime(async () => [204, 205].includes(status) ? new Response(null, { status }) : json({ data: categories }, status))('services/dashboard')
  await assert.rejects(getDashboardCategories(), error => {
    assert.match(getDashboardCategoriesErrorMessage(error), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
    return true
  })
})

test('categorias: falhas de rede, JSON e cancelamento não produzem dados', async () => {
  for (const fetch of [async () => { throw TypeError('Offline') }, async () => new Response('{'), async () => { throw new DOMException('Aborted', 'AbortError') }]) {
    const { getDashboardCategories } = await runtime(fetch)('services/dashboard')
    await assert.rejects(getDashboardCategories())
  }
})
