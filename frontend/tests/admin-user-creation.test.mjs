import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const draft = { name: ' Nome Completo ', email: ' NOVO@Example.Invalid ', role: 'requester', password: 'Senha!Segura123', password_confirmation: 'Senha!Segura123' }
const row = { id: 48, name: 'Nome Completo', email: 'novo@example.invalid', role: 'requester', disabled_at: null, created_at: '2026-10-27T12:00:00Z' }
const json = (body, status = 201) => new Response(JSON.stringify(body), { status })

test('cadastro de usuários: campos obrigatórios, limites e perfil restrito', async () => {
  const { validateAdminUserForm } = await runtime()('utils/admin-user-form')
  assert.equal(Object.keys(validateAdminUserForm(draft)).length, 0)
  for (const [field, values] of Object.entries({ name: ['', '  ', 'a'.repeat(256), 'A\0B'], email: ['', '  ', 'inválido', 'a@b\0c', 'a'.repeat(251) + '@a.co'], role: ['', 'admin', 'owner'] })) {
    for (const value of values) assert.ok(validateAdminUserForm({ ...draft, [field]: value })[field], `${field} inválido`)
  }
  assert.equal(Object.keys(validateAdminUserForm({ ...draft, name: 'é'.repeat(255), role: 'technician' })).length, 0)
})

for (const [label, password] of Object.entries({ vazio: '', curta: 'Aa1!', maiúscula: 'ABCDEFGHIJK1!', minúscula: 'abcdefghijk1!', número: 'Abcdefghijkl!', símbolo: 'Abcdefghijk12', NUL: 'Abcdefghi12!\0', bytes: 'Ab1!' + 'é'.repeat(35) })) {
  test(`cadastro de usuários: rejeita senha sem requisito ${label}`, async () => {
    const { validateAdminUserForm } = await runtime()('utils/admin-user-form')
    assert.ok(validateAdminUserForm({ ...draft, password, password_confirmation: password }).password)
  })
}

test('cadastro de usuários: bytes UTF-8, Unicode e confirmação', async () => {
  const { passwordByteLength, validateAdminUserForm } = await runtime()('utils/admin-user-form')
  for (const value of ['abc', 'ação', '漢字', '😀', '\ud800']) assert.equal(passwordByteLength(value), Buffer.byteLength(value))
  const password = 'Ab1!' + 'é'.repeat(34)
  assert.equal(passwordByteLength(password), 72)
  assert.equal(Object.keys(validateAdminUserForm({ ...draft, password, password_confirmation: password })).length, 0)
  assert.ok(validateAdminUserForm({ ...draft, password_confirmation: '' }).password_confirmation)
  assert.ok(validateAdminUserForm({ ...draft, password_confirmation: 'Senha!Diferente123' }).password_confirmation)
  // Espaços na senha são preservados e contam como símbolo, conforme o backend.
  assert.equal(Object.keys(validateAdminUserForm({ ...draft, password: 'Abcdefghij1 ', password_confirmation: 'Abcdefghij1 ' })).length, 0)
})

for (const role of ['requester', 'technician']) test(`cadastro de usuários: ${role}, CSRF e payload exato sem atributos internos`, async () => {
  const calls = []
  const { createAdminUser } = await runtime(async (url, options) => {
    calls.push(new URL(url).pathname)
    assert.equal(options.credentials, 'include')
    if (calls.length === 1) { assert.equal(options.method, 'GET'); return new Response(null, { status: 204 }) }
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.get('X-XSRF-TOKEN'), 'csrf test')
    assert.equal(options.headers.get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(options.body), { ...draft, name: 'Nome Completo', email: 'novo@example.invalid', role })
    return json({ data: { ...row, role, password: 'private-marker', sessions: ['private-marker'] }, private: 'private-marker' })
  })('services/admin-users')
  const result = await createAdminUser({ ...draft, role, id: 1, disabled_at: '2026-01-01', remember_token: 'private-marker' })
  assert.deepEqual(calls, ['/sanctum/csrf-cookie', '/api/admin/users'])
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...row, role })
  assert.equal(JSON.stringify(result).includes('private-marker'), false)
})

test('cadastro de usuários: valida antes de inicializar CSRF ou enviar POST', async () => {
  let calls = 0
  const { createAdminUser } = await runtime(async () => { calls++; throw Error('Não deve acessar API') })('services/admin-users')
  for (const overrides of [{ role: 'admin' }, { name: '' }, { email: '' }, { password: 'weak' }, { password_confirmation: '' }]) await assert.rejects(createAdminUser({ ...draft, ...overrides }))
  assert.equal(calls, 0)
})

for (const status of [401, 403, 419, 422, 503, 'offline', 200, 204, 'invalid']) test(`cadastro de usuários: erro POST ${status}, sem repetição automática ou senha na mensagem`, async () => {
  let posts = 0
  const load = runtime(async (url, options) => {
    if (options.method === 'GET') return new Response(null, { status: 204 })
    posts++
    if (status === 'offline') throw Error('Offline')
    if (status === 204) return new Response(null, { status })
    return json(status === 'invalid' ? { data: { id: 1 } } : { data: row, errors: { email: ['Já existe um usuário com esse e-mail.'] }, password: draft.password }, status === 'invalid' ? 201 : status)
  })
  const { createAdminUser, getCreateAdminUserErrorMessage } = await load('services/admin-users')
  await assert.rejects(createAdminUser(draft), cause => {
    const message = getCreateAdminUserErrorMessage(cause)
    assert.equal(message.includes(draft.password), false)
    if (status === 401 || status === 419) assert.match(message, /sessão expirou/)
    else if (status === 403) assert.match(message, /permissão/)
    else if (status === 422) { assert.match(message, /campos/); assert.equal(cause.validationErrors.email[0], 'Já existe um usuário com esse e-mail.') }
    else assert.match(message, /Consulte a listagem/)
    return true
  })
  assert.equal(posts, 1)
})

for (const status of [401, 403, 419, 500, 'offline']) test(`cadastro de usuários: falha CSRF ${status} impede POST`, async () => {
  let calls = 0
  const { createAdminUser } = await runtime(async (url, options) => {
    calls++
    assert.equal(new URL(url).pathname, '/sanctum/csrf-cookie')
    assert.equal(options.method, 'GET')
    if (status === 'offline') throw Error('Offline')
    return json({}, status)
  })('services/admin-users')
  await assert.rejects(createAdminUser(draft))
  assert.equal(calls, 1)
})
