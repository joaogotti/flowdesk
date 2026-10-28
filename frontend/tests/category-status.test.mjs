import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

for (const active of [true, false]) test(`situação: PATCH exclusivo booleano ${active} com sessão e CSRF`, async () => {
  const calls = []
  const { updateAdminCategoryStatus } = await runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : json({})
  })('services/admin-categories')
  await updateAdminCategoryStatus(8, { is_active: active, name: 'Não enviar', id: 2, tickets_count: 5 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/admin/categories/8/status')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.equal(calls[1].options.headers.get('Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(calls[1].options.body), { is_active: active })
})

test('situação: rejeita ID e situação inválidos sem rede', async () => {
  let calls = 0
  const { updateAdminCategoryStatus } = await runtime(async () => { calls++; return json({}) })('services/admin-categories')
  for (const id of [0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(updateAdminCategoryStatus(id, { is_active: true }))
  for (const is_active of [undefined, null, 1, 0, 'true', 'false']) await assert.rejects(updateAdminCategoryStatus(1, { is_active }))
  assert.equal(calls, 0)
})

for (const status of [401, 403, 404, 419, 422, 500, 201, 204, 'offline']) test(`situação: erro ${status}`, async () => {
  const { updateAdminCategoryStatus, getCategoryStatusErrorMessage } = await runtime(async url => {
    if (url.endsWith('/sanctum/csrf-cookie')) return new Response(null, { status: 204 })
    if (status === 'offline') throw TypeError('Offline')
    return status === 204 ? new Response(null, { status: 204 }) : json({ errors: { is_active: ['Situação inválida.'] } }, status)
  })('services/admin-categories')
  await assert.rejects(updateAdminCategoryStatus(1, { is_active: false }), error => {
    assert.match(getCategoryStatusErrorMessage(error), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /Situação inválida/ : /Não foi possível confirmar/)
    return true
  })
})
