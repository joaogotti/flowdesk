import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const user = { id: 8, name: 'Nome Atual', email: 'conta@example.invalid', role: 'requester' }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const passwords = { current_password: ' Legada!123 ', password: ' NovaSenha!Segura456 ', password_confirmation: ' NovaSenha!Segura456 ' }

test('rota de Configurações reconhecida e rotas existentes preservadas', async () => {
  const navigation = await runtime()('utils/navigation')
  assert.equal(navigation.parseWorkspaceHash('#/configuracoes').page, 'settings')
  assert.equal(navigation.parseWorkspaceHash('#/usuarios').page, 'users')
  assert.equal(navigation.parseWorkspaceHash('#/chamados/9').ticketId, '9')
})

test('perfil envia somente nome e precondição exata, com CSRF e cookies', async () => {
  const calls = []
  const service = await runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('csrf-cookie') ? new Response(null, { status: 204 }) : json({ data: { ...user, password: 'never expose', disabled_at: null } })
  })('services/settings')
  const result = await service.updateOwnName('Nome Atual', '  Nome Original  ')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), user)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'http://localhost:8000/api/user/profile')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Nome Atual', expected_name: '  Nome Original  ' })
})

test('senha preserva espaços, usa somente contrato permitido e aciona perda central', async () => {
  let sent
  const load = runtime(async (url, options) => {
    if (url.endsWith('csrf-cookie')) return new Response(null, { status: 204 })
    sent = options
    return json({ code: 'password_changed', reauthentication_required: true })
  })
  const service = await load('services/settings'), api = await load('services/api')
  let event; api.onAuthenticationLost(value => { event = value })
  await service.changeOwnPassword({ ...passwords, email: 'forbidden@example.invalid', role: 'admin' })
  assert.deepEqual(JSON.parse(sent.body), passwords)
  assert.equal(sent.method, 'PUT'); assert.equal(event.reason, 'password_changed')
  assert.equal(api.getAuthenticationLossMessage(event), 'Senha alterada. Entre novamente com a nova senha.')
})

for (const result of [{}, { code: 'password_changed' }, { code: 'password_changed', reauthentication_required: false }]) test(`sucesso de senha incompleto não encerra sessão: ${JSON.stringify(result)}`, async () => {
  const load = runtime(async url => url.endsWith('csrf-cookie') ? new Response(null, { status: 204 }) : json(result))
  const service = await load('services/settings'), api = await load('services/api')
  await assert.rejects(service.changeOwnPassword(passwords), /não confirmou/)
  assert.equal(api.getAuthenticationGeneration(), 0)
})

for (const result of [{}, { data: { id: 8 } }, user]) test('perfil rejeita resposta sem identidade válida no envelope data', async () => {
  const service = await runtime(async url => url.endsWith('csrf-cookie') ? new Response(null, { status: 204 }) : json(result))('services/settings')
  await assert.rejects(service.updateOwnName('Novo', 'Original'))
})

for (const [status, code, message] of [[401,'',/Entre novamente/], [401,'session_revoked',/Entre novamente/], [403,'',/permissão/], [409,'profile_changed',/outra sessão/], [419,'',/validar/], [422,'',/campos/], [429,'',/Muitas tentativas/], [503,'',/confirmar/]]) test(`erro ${status}/${code} preserva contrato e mensagem`, async () => {
  const service = await runtime(async url => url.endsWith('csrf-cookie') ? new Response(null, { status: 204 }) : json({ code, errors: { name: ['Nome inválido.'] } }, status))('services/settings')
  await assert.rejects(service.updateOwnName('Novo', 'Original'), cause => {
    assert.equal(cause.status, status); assert.match(service.getSettingsErrorMessage(cause), message)
    if (status === 422) assert.equal(cause.validationErrors.name[0], 'Nome inválido.')
    return true
  })
})

test('falha de CSRF não envia gravação nem encerra sessão válida', async () => {
  let calls = 0
  const load = runtime(async () => { calls++; return json({}, 401) })
  const service = await load('services/settings'), api = await load('services/api')
  await assert.rejects(service.changeOwnPassword(passwords), cause => /inicializar/.test(service.getSettingsErrorMessage(cause)))
  assert.equal(calls, 1); assert.equal(api.getAuthenticationGeneration(), 0)
})

for (const operation of ['profile', 'password']) test(`${operation}: CSRF antigo não grava na autenticação seguinte`, async () => {
  let release, calls = 0
  const load = runtime(async () => { calls++; return new Promise(resolve => { release = resolve }) })
  const service = await load('services/settings'), api = await load('services/api')
  const pending = assert.rejects(operation === 'profile' ? service.updateOwnName('Novo', 'Original') : service.changeOwnPassword(passwords), cause => cause.name === 'ObsoleteRequestError')
  api.beginAuthentication(); release(new Response(null, { status: 204 })); await pending
  assert.equal(calls, 1)
})

for (const operation of ['profile', 'password']) test(`${operation}: resposta tardia não devolve dados nem encerra login novo`, async () => {
  let release
  const load = runtime(async url => url.endsWith('csrf-cookie') ? new Response(null, { status: 204 }) : new Promise(resolve => { release = resolve }))
  const service = await load('services/settings'), api = await load('services/api')
  const pending = assert.rejects(operation === 'profile' ? service.updateOwnName('Novo', 'Original') : service.changeOwnPassword(passwords), cause => cause.name === 'ObsoleteRequestError')
  await new Promise(resolve => setImmediate(resolve))
  const generation = api.beginAuthentication(); api.confirmAuthentication(generation)
  release(json(operation === 'profile' ? { data: user } : { code: 'password_changed', reauthentication_required: true })); await pending
  assert.equal(api.getAuthenticationGeneration(), generation)
})

test('validação de senha aceita senha atual legada e preserva espaços', async () => {
  const { validatePasswordChange } = await runtime()('utils/settings-form')
  assert.deepEqual(Object.keys(validatePasswordChange(passwords)), [])
  assert.deepEqual(Object.keys(validatePasswordChange({ ...passwords, current_password: 'antiga' })), [])
})

for (const [field, value, pattern] of [
  ['current_password', '', /Preencha/], ['current_password', 'a\0b', /inválidos/],
  ['current_password', 'a'.repeat(73), /72 bytes/], ['password', '', /Preencha/],
  ['password', 'Ab1!', /12 caracteres/], ['password', 'abcdefghijkl1!', /maiúscula/],
  ['password', 'ABCDEFGHIJKL1!', /minúscula/], ['password', 'Abcdefghijkl!', /número/],
  ['password', 'Abcdefghijkl1', /símbolo/], ['password', 'NovaSenha!123\0', /inválidos/],
  ['password', 'Á'.repeat(35)+'a1!', /72 bytes/], ['password', passwords.current_password, /diferente/],
  ['password_confirmation', '', /Preencha/], ['password_confirmation', 'Diferente!123', /não corresponde/],
  ['password_confirmation', 'a'.repeat(73), /72 bytes/], ['password_confirmation', 'a\0b', /inválidos/],
]) test(`validação ${field}: ${JSON.stringify(value)}`, async () => {
  const { validatePasswordChange } = await runtime()('utils/settings-form')
  assert.match(validatePasswordChange({ ...passwords, [field]: value })[field], pattern)
})
