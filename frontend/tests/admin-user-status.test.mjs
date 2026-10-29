import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const row = { id: 8, name: 'Pessoa', email: 'pessoa@example.invalid', role: 'technician', disabled_at: null, created_at: '2026-10-27T12:00:00Z' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const plain = value => JSON.parse(JSON.stringify(value))

test('situação: somente administrador pode alterar outra conta, ativa ou desativada', async () => {
  const { canChangeAdminUserStatus } = await runtime()('utils/admin-user-status')
  for (const disabled_at of [null, '2026-10-29T10:00:00Z']) {
    assert.equal(canChangeAdminUserStatus({ id: 1, role: 'admin' }, { ...row, disabled_at }), true)
    assert.equal(canChangeAdminUserStatus({ id: 8, role: 'admin' }, { ...row, disabled_at }), false)
    for (const role of ['requester', 'technician']) assert.equal(canChangeAdminUserStatus({ id: 1, role }, row), false)
  }
})

for (const role of ['requester', 'technician', 'admin']) for (const active of [true, false]) {
  test(`situação ${role}: ${active ? 'desativar' : 'ativar'}, payload exato, CSRF e resposta pública`, async () => {
    const calls = []
    const expected = { ...row, role, disabled_at: active ? '2026-10-29T10:00:00Z' : null }
    const { updateAdminUserStatus } = await runtime(async (url, options) => {
      calls.push(new URL(url).pathname)
      assert.equal(options.credentials, 'include')
      if (options.method === 'GET') return new Response(null, { status: 204 })
      assert.equal(options.method, 'PATCH')
      assert.equal(options.headers.get('X-XSRF-TOKEN'), 'csrf test')
      assert.equal(options.headers.get('Content-Type'), 'application/json')
      assert.deepEqual(JSON.parse(options.body), { is_active: !active, expected_is_active: active })
      return json({ data: { ...expected, session_version: 7, password: 'private-marker', audit: 'private-marker' } })
    })('services/admin-users')
    const result = await updateAdminUserStatus(8, { is_active: !active, expected_is_active: active, name: 'Do not send', disabled_at: null, role: 'admin', session_version: 0 })
    assert.deepEqual(calls, ['/sanctum/csrf-cookie', '/api/admin/users/8/status'])
    assert.deepEqual(plain(result), expected)
  })
}

test('situação: valores inválidos e operação sem mudança não fazem requisições', async () => {
  let calls = 0
  const { updateAdminUserStatus } = await runtime(async () => { calls++; throw Error('Unexpected fetch') })('services/admin-users')
  for (const id of [0, -1, NaN, Infinity, 1.5, '8', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(updateAdminUserStatus(id, { is_active: false, expected_is_active: true }))
  for (const input of [{}, { is_active: false }, { expected_is_active: true }, { is_active: false, expected_is_active: false }, { is_active: true, expected_is_active: true }, { is_active: 0, expected_is_active: true }, { is_active: false, expected_is_active: 'true' }, { is_active: null, expected_is_active: true }]) await assert.rejects(updateAdminUserStatus(8, input))
  assert.equal(calls, 0)
})

for (const status of [401, 403, 404, 409, 419, 422, 503, 'offline']) {
  test(`situação: erro ${status} não repete PATCH e preserva código seguro`, async () => {
    let patches = 0
    const load = runtime(async (_url, options) => {
      if (options.method === 'GET') return new Response(null, { status: 204 })
      patches++
      if (status === 'offline') throw Error('Offline')
      return json({ code: 'status_changed', errors: { expected_is_active: ['private-marker'] }, message: 'private-marker' }, status)
    })
    const { updateAdminUserStatus, getUpdateAdminUserStatusErrorMessage } = await load('services/admin-users')
    await assert.rejects(updateAdminUserStatus(8, { is_active: false, expected_is_active: true }), cause => {
      if (status !== 'offline') assert.equal(cause.status, status)
      assert.equal(getUpdateAdminUserStatusErrorMessage(cause).includes('private-marker'), false)
      return true
    })
    assert.equal(patches, 1)
  })
}

for (const [code, message] of [['status_changed', /outra pessoa/], ['active_assignments', /chamados atribuídos/], ['last_active_admin', /administrador ativo/], ['session_version_exhausted', /renovar a autenticação/], ['unknown', /conflito/]]) {
  test(`situação: conflito ${code} tem mensagem específica e sem detalhes internos`, async () => {
    const load = runtime()
    const { ApiError } = await load('services/api')
    const { getUpdateAdminUserStatusErrorMessage } = await load('services/admin-users')
    assert.match(getUpdateAdminUserStatusErrorMessage(new ApiError(409, {}, 'private-marker', code)), message)
  })
}

for (const result of [{}, { data: { ...row, id: 9, disabled_at: '2026-10-29T10:00:00Z' } }, { data: row }, { data: { ...row, disabled_at: 'invalid' } }, { data: { ...row, role: 'owner', disabled_at: '2026-10-29T10:00:00Z' } }]) {
  test('situação: resposta incoerente não confirma sucesso', async () => {
    let patches = 0
    const { updateAdminUserStatus } = await runtime(async (_url, options) => {
      if (options.method === 'GET') return new Response(null, { status: 204 })
      patches++
      return json(result)
    })('services/admin-users')
    await assert.rejects(updateAdminUserStatus(8, { is_active: false, expected_is_active: true }))
    assert.equal(patches, 1)
  })
}

test('situação: falha de CSRF impede PATCH', async () => {
  let calls = 0
  const { updateAdminUserStatus } = await runtime(async () => { calls++; return json({}, 419) })('services/admin-users')
  await assert.rejects(updateAdminUserStatus(8, { is_active: false, expected_is_active: true }))
  assert.equal(calls, 1)
})
