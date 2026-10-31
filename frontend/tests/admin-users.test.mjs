import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const filters = { search: '', role: '', status: '', page: 1, per_page: 15 }
const row = { id: 8, name: 'Técnico', email: 'tecnico@example.invalid', role: 'technician', disabled_at: null, created_at: '2026-10-22T00:43:42Z' }
const payload = () => ({ data: [row], current_page: 1, last_page: 1, per_page: 15, total: 1, from: 1, to: 1,
  first_page_url: 'http://flowdesk.test/api/admin/users?page=1', last_page_url: 'http://flowdesk.test/api/admin/users?page=1',
  next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/admin/users', links: [{ url: null, label: 'Anterior', active: false }] })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('usuários: rota administrativa por hash preserva rotas existentes', async () => {
  const { parseWorkspaceHash } = await runtime()('utils/navigation')
  assert.equal(parseWorkspaceHash('#/usuarios').page, 'users')
  assert.equal(parseWorkspaceHash('#/categorias').page, 'categories')
  assert.equal(parseWorkspaceHash('#/chamados/8').ticketId, '8')
})

test('usuários: GET com sessão e sinal, somente filtros previstos e sem CSRF ou corpo', async () => {
  const controller = new AbortController(), calls = []
  const { getAdminUsers } = await runtime(async (url, options) => {
    calls.push(url)
    const request = new URL(url)
    assert.equal(request.origin, 'http://localhost:8000')
    assert.equal(request.pathname, '/api/admin/users')
    assert.deepEqual(Object.fromEntries(request.searchParams), { page: '2', per_page: '1', search: 'a&b@example.invalid', role: 'admin', status: 'disabled' })
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.signal.aborted, false)
    assert.equal(options.headers.get('Accept'), 'application/json')
    assert.equal(options.headers.has('X-XSRF-TOKEN'), false)
    assert.equal(options.body, undefined)
    return json({ ...payload(), current_page: 2, last_page: 2, per_page: 1, total: 2, from: 2, to: 2 })
  })('services/admin-users')
  await getAdminUsers({ ...filters, page: 2, per_page: 1, search: ' a&b@example.invalid ', role: 'admin', status: 'disabled', password: 'never-send' }, controller.signal)
  assert.equal(calls.length, 1)
})

test('usuários: filtros vazios omitidos e projeção exclui dados sensíveis', async () => {
  const data = payload()
  data.data = [{ ...row, password: 'secret-marker', remember_token: 'secret-marker', sessions: ['secret-marker'], updated_at: 'secret-marker' }]
  data.private = 'secret-marker'
  data.links[0].private = 'secret-marker'
  const { getAdminUsers } = await runtime(async url => {
    assert.deepEqual(Object.fromEntries(new URL(url).searchParams), { page: '1', per_page: '15' })
    return json(data)
  })('services/admin-users')
  const result = JSON.parse(JSON.stringify(await getAdminUsers({ ...filters, search: '  ' })))
  assert.deepEqual(result.data, [row])
  assert.equal(JSON.stringify(result).includes('secret-marker'), false)
})

test('usuários: datas nulas e futura desativação preservadas; página vazia fora dos resultados aceita', async () => {
  let data = { ...payload(), data: [{ ...row, created_at: null, disabled_at: '2030-01-01T00:00:00Z' }] }
  const { getAdminUsers } = await runtime(async () => json(data))('services/admin-users')
  assert.deepEqual(JSON.parse(JSON.stringify((await getAdminUsers(filters)).data)), data.data)
  data = { ...payload(), data: [], total: 0, from: null, to: null }
  assert.equal((await getAdminUsers(filters)).total, 0)
  data = { ...payload(), data: [], current_page: 3, from: null, to: null }
  assert.equal((await getAdminUsers({ ...filters, page: 3 })).data.length, 0)
})

test('usuários: rejeita filtros inválidos antes de consultar a API', async () => {
  let calls = 0
  const { getAdminUsers } = await runtime(async () => { calls++; return json(payload()) })('services/admin-users')
  for (const invalid of [{ page: 0 }, { page: 1000001 }, { page: 1.5 }, { per_page: 0 }, { per_page: 101 }, { role: 'owner' }, { status: 'inactive' }, { search: 'a'.repeat(256) }, { search: 'a\0b' }]) {
    await assert.rejects(getAdminUsers({ ...filters, ...invalid }))
  }
  assert.equal(calls, 0)
})

test('usuários: valida registros, paginação, URLs, links e IDs duplicados', async () => {
  let data
  const { getAdminUsers } = await runtime(async () => json(data))('services/admin-users')
  for (const invalid of [null, [], {}, { ...payload(), data: null }, { ...payload(), data: [null] },
    { ...payload(), data: [row, row], total: 2, to: 2 }]) {
    data = invalid; await assert.rejects(getAdminUsers(filters))
  }
  for (const [field, values] of Object.entries({ id: [0, '8', 1.5, Number.MAX_SAFE_INTEGER + 1], name: ['', null], email: ['', 1], role: ['owner', 'constructor'], disabled_at: ['invalid', false], created_at: ['invalid', 1] })) {
    for (const value of [undefined, ...values]) {
      data = { ...payload(), data: [{ ...row, [field]: value }] }
      await assert.rejects(getAdminUsers(filters), /formato esperado/)
    }
  }
  for (const invalid of [{ current_page: 0 }, { last_page: 2 }, { per_page: 101 }, { total: -1 }, { from: 2 }, { to: 9 },
    { links: [{}] }, { next_page_url: 3 }, { prev_page_url: false }, { first_page_url: null }, { path: null }]) {
    data = { ...payload(), ...invalid }; await assert.rejects(getAdminUsers(filters))
  }
})

for (const status of [401, 403, 419, 422, 500, 201, 204, 'offline']) test(`usuários: erro ${status} com mensagem apropriada`, async () => {
  const { getAdminUsers, getAdminUsersErrorMessage } = await runtime(async () => {
    if (status === 'offline') throw TypeError('Offline')
    return status === 204 ? new Response(null, { status }) : json({ errors: { search: ['Pesquisa inválida.'] } }, status)
  })('services/admin-users')
  await assert.rejects(getAdminUsers(filters), error => {
    assert.match(getAdminUsersErrorMessage(error), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 422 ? /Pesquisa inválida/ : /Não foi possível carregar/)
    return true
  })
})
