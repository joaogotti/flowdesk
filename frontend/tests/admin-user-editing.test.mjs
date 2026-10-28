import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const original = { name: 'Nome  Original', email: 'original@example.invalid' }
const row = { id: 8, ...original, role: 'technician', disabled_at: null, created_at: '2026-10-27T12:00:00Z' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const plain = value => JSON.parse(JSON.stringify(value))

test('edição: normalização Laravel, espaços internos e ausência de mudanças', async () => {
  const { normalizeAdminUserEditValues, getAdminUserChanges } = await runtime()('utils/admin-user-form')
  assert.deepEqual(plain(normalizeAdminUserEditValues({ name: '\u200b\t Nome  Original \n\u00a0\u2800', email: '\u2060 ORIGINAL@Example.Invalid\u0085' })), original)
  for (const values of [original, { name: ' Nome  Original ', email: ' ORIGINAL@EXAMPLE.INVALID ' }]) assert.deepEqual(plain(getAdminUserChanges(original, values)), {})
  assert.deepEqual(plain(getAdminUserChanges(original, { ...original, name: 'Outro Nome' })), { name: 'Outro Nome' })
  assert.deepEqual(plain(getAdminUserChanges(original, { ...original, email: ' NOVO@Example.Invalid ' })), { email: 'novo@example.invalid' })
  assert.deepEqual(plain(getAdminUserChanges(original, { name: ' Outro ', email: ' NOVO@Example.Invalid ' })), { name: 'Outro', email: 'novo@example.invalid' })
})

test('edição: campos inválidos, Unicode e NUL antes de qualquer normalização', async () => {
  const { validateAdminUserEditForm } = await runtime()('utils/admin-user-form')
  assert.deepEqual(plain(validateAdminUserEditForm(original)), {})
  for (const name of ['', ' ', '\u200b', 'a'.repeat(256), '\0Nome', 'No\0me', 'Nome\0', null, [], undefined]) assert.ok(validateAdminUserEditForm({ name }).name)
  for (const email of ['', ' ', 'inválido', 'a@@b', 'a b@c', 'a'.repeat(256) + '@b', '\0a@b.com', 'a\0@b.com', 'a@b.com\0', '\u200b\0a@b.com\u200b', null, {}, undefined]) assert.ok(validateAdminUserEditForm({ email }).email)
  assert.deepEqual(plain(validateAdminUserEditForm({ name: '😀'.repeat(255), email: ' pessoa+tag@example.invalid ' })), {})
})

for (const [label, input, expected] of [
  ['nome', { name: ' Novo  Nome ' }, { name: 'Novo  Nome' }],
  ['e-mail', { email: ' NOVO@Example.Invalid ' }, { email: 'novo@example.invalid' }],
  ['ambos', { name: ' Novo ', email: ' NOVO@Example.Invalid ' }, { name: 'Novo', email: 'novo@example.invalid' }],
]) test(`edição ${label}: PATCH parcial, CSRF e atributos estritamente permitidos`, async () => {
  const calls = []
  const { updateAdminUser } = await runtime(async (url, options) => {
    calls.push(new URL(url).pathname)
    assert.equal(options.credentials, 'include')
    if (options.method === 'GET') return new Response(null, { status: 204 })
    assert.equal(options.method, 'PATCH')
    assert.equal(options.headers.get('X-XSRF-TOKEN'), 'csrf test')
    assert.equal(options.headers.get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(options.body), expected)
    return json({ data: { ...row, ...expected, password: 'private-marker', remember_token: 'private-marker' } })
  })('services/admin-users')
  const updated = await updateAdminUser(8, { ...input, id: 1, role: 'admin', password: 'private-marker', disabled_at: '2026-01-01', internal: 'private-marker' })
  assert.deepEqual(calls, ['/sanctum/csrf-cookie', '/api/admin/users/8'])
  assert.deepEqual(plain(updated), { ...row, ...expected })
})

test('edição: administrador e conta desativada mantêm perfil e situação', async () => {
  const { updateAdminUser } = await runtime(async (_url, options) => options.method === 'GET' ? new Response(null, { status: 204 }) : json({ data: { ...row, id: 1, role: 'admin', disabled_at: '2026-10-01T12:00:00Z' } }))('services/admin-users')
  const result = await updateAdminUser(1, { name: 'Nome' })
  assert.equal(result.role, 'admin')
  assert.equal(result.disabled_at, '2026-10-01T12:00:00Z')
})

test('edição: IDs e entradas inválidas impedem CSRF e PATCH', async () => {
  let calls = 0
  const { updateAdminUser } = await runtime(async () => { calls++; throw Error('Unexpected API request') })('services/admin-users')
  for (const id of [0, -1, 1.5, NaN, Infinity, '8', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(updateAdminUser(id, { name: 'Nome' }))
  for (const input of [{}, { role: 'admin' }, { name: '' }, { email: '' }, { name: null }, { email: undefined }, { email: 'novo@example.invalid\0' }]) await assert.rejects(updateAdminUser(8, input))
  assert.equal(calls, 0)
})

for (const status of [401, 403, 404, 419, 422, 503, 'offline', 201, 204, 'invalid', 'wrong-id', 'invalid-json']) test(`edição: PATCH ${status} sem reenvio automático`, async () => {
  let patches = 0
  const { updateAdminUser, getUpdateAdminUserErrorMessage } = await runtime(async (_url, options) => {
    if (options.method === 'GET') return new Response(null, { status: 204 })
    patches++
    if (status === 'offline') throw Error('Offline')
    if (status === 204) return new Response(null, { status })
    if (status === 'invalid-json') return new Response('{', { status: 200 })
    if (status === 'invalid') return json({ data: { id: 8 } })
    if (status === 'wrong-id') return json({ data: { ...row, id: 9 } })
    return json({ data: row, errors: { email: ['Já existe um usuário com esse e-mail.'] } }, status)
  })('services/admin-users')
  await assert.rejects(updateAdminUser(8, { email: 'novo@example.invalid' }), cause => {
    const message = getUpdateAdminUserErrorMessage(cause)
    assert.match(message, [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /campos/ : /Consulte a listagem/)
    if (status === 422) assert.equal(cause.validationErrors.email[0], 'Já existe um usuário com esse e-mail.')
    return true
  })
  assert.equal(patches, 1)
})

for (const status of [401, 403, 419, 500, 'offline']) test(`edição: CSRF ${status} impede PATCH`, async () => {
  let calls = 0
  const { updateAdminUser } = await runtime(async (url, options) => {
    calls++
    assert.equal(new URL(url).pathname, '/sanctum/csrf-cookie')
    assert.equal(options.method, 'GET')
    if (status === 'offline') throw Error('Offline')
    return json({}, status)
  })('services/admin-users')
  await assert.rejects(updateAdminUser(8, { name: 'Nome' }))
  assert.equal(calls, 1)
})
