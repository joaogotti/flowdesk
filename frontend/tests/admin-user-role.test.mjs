import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const row = { id: 8, name: 'Pessoa de teste', email: 'pessoa@example.invalid', role: 'technician', disabled_at: null, created_at: '2026-10-27T12:00:00Z' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const plain = value => JSON.parse(JSON.stringify(value))

test('perfil: somente administrador, outro usuário e conta ativa são elegíveis', async () => {
  const { canChangeAdminUserRole, isUserRole } = await runtime()('utils/admin-user-role')
  assert.equal(canChangeAdminUserRole({ id: 1, role: 'admin' }, row), true)
  assert.equal(canChangeAdminUserRole({ id: 8, role: 'admin' }, row), false)
  assert.equal(canChangeAdminUserRole({ id: 1, role: 'admin' }, { ...row, disabled_at: '2030-01-01T00:00:00Z' }), false)
  for (const role of ['requester','technician']) assert.equal(canChangeAdminUserRole({ id: 1, role }, row), false)
  for (const role of ['requester','technician','admin']) assert.equal(isUserRole(role), true)
  for (const role of ['', 'owner', 'ADMIN', ' admin ', null, {}, ['admin'], 1]) assert.equal(isUserRole(role), false)
})

for (const from of ['requester','technician','admin']) for (const to of ['requester','technician','admin']) {
  if (from === to) continue
  test(`perfil ${from} -> ${to}: payload exato, CSRF, sessão e resposta pública`, async () => {
    const calls = []
    const { updateAdminUserRole } = await runtime(async (url, options) => {
      calls.push(new URL(url).pathname)
      assert.equal(options.credentials, 'include')
      if (options.method === 'GET') return new Response(null, { status: 204 })
      assert.equal(options.method, 'PATCH')
      assert.equal(options.headers.get('X-XSRF-TOKEN'), 'csrf test')
      assert.equal(options.headers.get('Content-Type'), 'application/json')
      assert.deepEqual(JSON.parse(options.body), { role: to, expected_role: from })
      return json({ data: { ...row, role: to, password: 'private-marker', audit: ['private-marker'] } })
    })('services/admin-users')
    const result = await updateAdminUserRole(8, { role: to, expected_role: from, id: 1, name: 'Não enviar', email: 'nao@example.invalid', disabled_at: 'date', password: 'private-marker' })
    assert.deepEqual(calls, ['/sanctum/csrf-cookie','/api/admin/users/8/role'])
    assert.deepEqual(plain(result), { ...row, role: to })
  })
}

test('perfil: payload inválido e perfil igual não acessam CSRF nem API', async () => {
  let calls = 0
  const { updateAdminUserRole } = await runtime(async () => { calls++; throw Error('Unexpected fetch') })('services/admin-users')
  for (const id of [0,-1,NaN,Infinity,1.5,'8',Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(updateAdminUserRole(id, { role: 'admin', expected_role: 'technician' }))
  for (const input of [{}, { role: 'admin' }, { expected_role: 'technician' }, { role: 'owner', expected_role: 'technician' }, { role: 'admin', expected_role: [] }, { role: null, expected_role: 'technician' }, { role: 'technician', expected_role: 'technician' }]) await assert.rejects(updateAdminUserRole(8, input))
  assert.equal(calls, 0)
})

for (const [code, message] of [
  ['role_changed', /outra pessoa/], ['active_assignments', /chamados atribuídos/],
  ['last_active_admin', /administrador ativo/], ['target_disabled', /desativada/],
  ['private-marker', /conflito/], [undefined, /conflito/], [17, /conflito/],
]) test(`perfil: conflito ${code} traduzido sem expor dados internos`, async () => {
  let patches = 0
  const { updateAdminUserRole, getUpdateAdminUserRoleErrorMessage } = await runtime(async (_url, options) => {
    if (options.method === 'GET') return new Response(null, { status: 204 })
    patches++
    return json({ code, message: 'private-marker SQL users', internal: 'private-marker' }, 409)
  })('services/admin-users')
  await assert.rejects(updateAdminUserRole(8, { role: 'admin', expected_role: 'technician' }), cause => {
    assert.equal(cause.status, 409)
    assert.equal(cause.code, typeof code === 'string' ? code : undefined)
    assert.match(getUpdateAdminUserRoleErrorMessage(cause), message)
    assert.equal(getUpdateAdminUserRoleErrorMessage(cause).includes('private-marker'), false)
    return true
  })
  assert.equal(patches, 1)
})

for (const status of [401,403,404,419,422,503,'offline',201,204,'invalid','wrong-id','wrong-role','disabled','invalid-json']) test(`perfil: erro ${status} não repete PATCH ou simula sucesso`, async () => {
  let patches = 0
  const { updateAdminUserRole, getUpdateAdminUserRoleErrorMessage } = await runtime(async (_url, options) => {
    if (options.method === 'GET') return new Response(null, { status: 204 })
    patches++
    if (status === 'offline') throw TypeError('Offline')
    if (status === 204) return new Response(null, { status })
    if (status === 'invalid-json') return new Response('{', { status: 200 })
    if (status === 'invalid') return json({ data: { id: 8 } })
    if (status === 'wrong-id') return json({ data: { ...row, id: 9, role: 'admin' } })
    if (status === 'wrong-role') return json({ data: row })
    if (status === 'disabled') return json({ data: { ...row, role: 'admin', disabled_at: '2026-10-01T00:00:00Z' } })
    return json({ data: { ...row, role: 'admin' }, message: 'private-marker', errors: { role: ['Perfil inválido.'] } }, status)
  })('services/admin-users')
  await assert.rejects(updateAdminUserRole(8, { role: 'admin', expected_role: 'technician' }), cause => {
    assert.match(getUpdateAdminUserRoleErrorMessage(cause), [401,419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /perfil selecionado/ : /Não foi possível confirmar/)
    assert.equal(getUpdateAdminUserRoleErrorMessage(cause).includes('private-marker'), false)
    return true
  })
  assert.equal(patches, 1)
})

for (const status of [401,403,419,500,'offline']) test(`perfil: erro CSRF ${status} não envia PATCH`, async () => {
  let calls = 0
  const { updateAdminUserRole } = await runtime(async (url, options) => {
    calls++
    assert.equal(new URL(url).pathname, '/sanctum/csrf-cookie')
    assert.equal(options.method, 'GET')
    if (status === 'offline') throw Error('Offline')
    return json({}, status)
  })('services/admin-users')
  await assert.rejects(updateAdminUserRole(8, { role: 'admin', expected_role: 'technician' }))
  assert.equal(calls, 1)
})
