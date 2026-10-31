import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const user = { id: 8, name: 'Pessoa', email: 'pessoa@example.invalid', role: 'admin' }
const credentials = { email: user.email, password: 'synthetic-password' }
const obsolete = cause => cause.name === 'ObsoleteRequestError'

for (const binary of [false, true]) for (const body of ['generic', 'empty', 'html', 'revoked']) test(`401 ${body}/${binary ? 'Blob' : 'JSON'} confirma perda atual`, async () => {
  const api = await runtime(async () => body === 'revoked' ? json({ code: 'session_revoked' }, 401) : new Response(body === 'html' ? '<html>Unauthorized</html>' : body === 'empty' ? '' : '{}', { status: 401 }))('services/api')
  const events = []; api.onAuthenticationLost(event => events.push(event)); api.confirmAuthentication(0)
  await assert.rejects(binary ? api.apiBlobRequest('/file') : api.apiRequest('/user'), cause => cause.status === 401)
  assert.equal(events.length, 1); assert.equal(events[0].reason, body === 'revoked' ? 'revoked' : 'expired')
  assert.equal(events[0].wasAuthenticated, true)
  assert.match(api.getAuthenticationLossMessage(events[0]), body === 'revoked' ? /revogada/ : /expirou/)
})

test('403, 419 e 401 de login, health ou CSRF preservam a autenticação', async () => {
  let status = 403
  const api = await runtime(async () => json({ code: 'session_revoked' }, status))('services/api')
  let losses = 0; api.onAuthenticationLost(() => losses++); api.confirmAuthentication(0)
  for (status of [403, 419]) await assert.rejects(api.apiRequest('/user'))
  status = 401
  await assert.rejects(api.apiRequest('/login', { method: 'POST' }))
  await assert.rejects(api.apiRequest('/health')); await assert.rejects(api.initializeCsrf())
  assert.equal(losses, 0); assert.equal(api.getAuthenticationGeneration(), 0)
})

for (const status of [200, 204, 401, 403, 419, 503]) test(`resposta antiga ${status} não limpa login novo nem devolve dados`, async () => {
  let release
  const api = await runtime(async () => new Promise(resolve => { release = resolve }))('services/api')
  let losses = 0; api.onAuthenticationLost(() => losses++)
  const old = api.apiRequest('/slow'), rejected = assert.rejects(old, obsolete)
  const epoch = api.beginAuthentication(); api.confirmAuthentication(epoch)
  release(status === 204 ? new Response(null, { status }) : json({ ...user, code: 'session_revoked' }, status))
  await rejected
  assert.equal(api.getAuthenticationGeneration(), epoch); assert.equal(losses, 0)
})

test('corpo 401 atrasado também respeita a geração', async () => {
  let release
  const response = json({}, 401); response.text = () => new Promise(resolve => { release = resolve })
  const api = await runtime(async () => response)('services/api')
  const rejected = assert.rejects(api.apiRequest('/user'), obsolete)
  await new Promise(resolve => setImmediate(resolve))
  const epoch = api.beginAuthentication(); api.confirmAuthentication(epoch)
  release('{"code":"session_revoked"}'); await rejected
  assert.equal(api.getAuthenticationGeneration(), epoch)
})

test('cancelamento externo não confirma perda de autenticação', async () => {
  let release, transportSignal
  const api = await runtime(async (_url, options) => { transportSignal = options.signal; return new Promise(resolve => { release = resolve }) })('services/api')
  let losses = 0; api.onAuthenticationLost(() => losses++)
  const controller = new AbortController(), rejected = assert.rejects(api.apiRequest('/user', { signal: controller.signal }), cause => cause.name === 'AbortError')
  controller.abort(); assert.equal(transportSignal.aborted, true)
  release(json({}, 401)); await rejected; assert.equal(losses, 0)
})

test('401 concorrentes antigos notificam somente uma perda', async () => {
  const releases = [], api = await runtime(async () => new Promise(resolve => releases.push(resolve)))('services/api')
  let losses = 0; api.onAuthenticationLost(() => losses++)
  const a = assert.rejects(api.apiRequest('/a'), cause => cause.status === 401), b = assert.rejects(api.apiRequest('/b'), obsolete)
  releases[0](json({}, 401)); await a; releases[1](json({ code: 'session_revoked' }, 401)); await b
  assert.equal(losses, 1)
})

test('identidade pendente não é reaproveitada depois de um login novo', async () => {
  let release, calls = 0
  const load = runtime(async url => url.endsWith('/user') ? (++calls === 1 ? new Promise(resolve => { release = resolve }) : json({ ...user, id: 9 })) : url.endsWith('/login') ? json({ ...user, id: 9 }) : new Response(null, { status: 204 }))
  const auth = await load('services/auth')
  const rejected = assert.rejects(auth.getCurrentUser(), obsolete)
  await auth.login(credentials); assert.equal((await auth.getCurrentUser()).id, 9)
  release(json(user)); await rejected
  assert.equal((await auth.getCurrentUser()).id, 9); assert.equal(calls, 3)
})

test('finally da identidade antiga não remove a consulta pendente da geração nova', async () => {
  const releases = []
  const load = runtime(async url => url.endsWith('/user') ? new Promise(resolve => releases.push(resolve)) : url.endsWith('/login') ? json(user) : new Response(null, { status: 204 }))
  const auth = await load('services/auth')
  const old = assert.rejects(auth.getCurrentUser(), obsolete)
  await auth.login(credentials)
  const fresh = auth.getCurrentUser()
  releases[0](json({}, 401)); await old
  const shared = auth.getCurrentUser()
  assert.equal(releases.length, 2)
  releases[1](json({ ...user, id: 9 }))
  assert.equal((await fresh).id, 9); assert.equal((await shared).id, 9)
})

test('logout atrasado não encerra o login mais recente', async () => {
  let release
  const load = runtime(async url => url.endsWith('/logout') ? new Promise(resolve => { release = resolve }) : url.endsWith('/login') ? json(user) : new Response(null, { status: 204 }))
  const auth = await load('services/auth'), api = await load('services/api')
  let losses = 0; api.onAuthenticationLost(() => losses++)
  const rejected = assert.rejects(auth.logout(), obsolete)
  await new Promise(resolve => setImmediate(resolve))
  await auth.login(credentials)
  const epoch = api.getAuthenticationGeneration()
  release(new Response(null, { status: 204 })); await rejected
  assert.equal(api.getAuthenticationGeneration(), epoch); assert.equal(losses, 0)
})

test('erro de um login antigo não limpa outro login concluído', async () => {
  let release, logins = 0
  const load = runtime(async url => url.endsWith('/login') ? (++logins === 1 ? new Promise(resolve => { release = resolve }) : json(user)) : new Response(null, { status: 204 }))
  const auth = await load('services/auth'), api = await load('services/api')
  let losses = 0; api.onAuthenticationLost(() => losses++)
  const rejected = assert.rejects(auth.login(credentials), obsolete)
  await new Promise(resolve => setImmediate(resolve))
  await auth.login(credentials)
  release(json({}, 401)); await rejected
  assert.equal(losses, 0)
})

test('login inválido e CSRF recusado têm mensagens distintas sem logout', async () => {
  for (const csrfFailure of [false, true]) {
    const load = runtime(async url => url.endsWith('/login') || csrfFailure ? json({}, 401) : new Response(null, { status: 204 }))
    const auth = await load('services/auth'), api = await load('services/api')
    let losses = 0; api.onAuthenticationLost(() => losses++)
    await assert.rejects(auth.login(credentials), cause => { assert.match(auth.getAuthErrorMessage(cause, 'login'), csrfFailure ? /inicializar/ : /E-mail ou senha inválidos/); return true })
    assert.equal(losses, 0)
  }
})

for (const binary of [false, true]) test(`logout invalida respostas ${binary ? 'Blob' : 'JSON'} antigas`, async () => {
  let release
  const load = runtime(async url => url.endsWith('/slow') ? new Promise(resolve => { release = resolve }) : new Response(null, { status: 204 }))
  const api = await load('services/api'), auth = await load('services/auth'), events = []
  api.onAuthenticationLost(event => events.push(event))
  const rejected = assert.rejects(binary ? api.apiBlobRequest('/slow') : api.apiRequest('/slow'), obsolete)
  await auth.logout(); release(binary ? new Response('abc') : json(user)); await rejected
  assert.equal(events.length, 1); assert.equal(events[0].reason, 'logout')
})

for (const csrf of [false, true]) for (const status of [403, 419]) test(`logout ${status}/${csrf ? 'CSRF' : 'POST'} preserva sessão`, async () => {
  const load = runtime(async url => !csrf && url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : json({}, status))
  const api = await load('services/api'), auth = await load('services/auth')
  let losses = 0; api.onAuthenticationLost(() => losses++)
  await assert.rejects(auth.logout()); assert.equal(losses, 0); assert.equal(api.getAuthenticationGeneration(), 0)
})

test('preparação CSRF antiga não envia escrita com uma identidade nova', async () => {
  let release, patches = 0
  const load = runtime(async (_url, options) => options.method === 'GET' ? new Promise(resolve => { release = resolve }) : (patches++, json({ data: user })))
  const api = await load('services/api'), service = await load('services/admin-users')
  const rejected = assert.rejects(service.updateAdminUser(8, { name: 'Novo', expected_name: 'Pessoa' }), obsolete)
  api.beginAuthentication(); release(new Response(null, { status: 204 })); await rejected; assert.equal(patches, 0)
})

test('password_changed confirmado encerra identidade e prepara mensagem estável', async () => {
  const api = await runtime(async () => json({ code: 'password_changed', reauthentication_required: true }))('services/api'), events = []
  api.onAuthenticationLost(event => events.push(event))
  assert.equal((await api.apiRequest('/user/password', { method: 'PUT' }, 200)).code, 'password_changed')
  assert.equal(api.getAuthenticationLossMessage(events[0]), 'Senha alterada. Entre novamente com a nova senha.')
})

test('resposta de senha inválida, fora do endpoint ou antiga não encerra sessão', async () => {
  for (const [path, body] of [['/other', { code: 'password_changed', reauthentication_required: true }], ['/user/password', { code: 'password_changed' }]]) {
    const api = await runtime(async () => json(body))('services/api')
    let losses = 0; api.onAuthenticationLost(() => losses++)
    await api.apiRequest(path, { method: 'PUT' }); assert.equal(losses, 0)
  }
  let release
  const api = await runtime(async () => new Promise(resolve => { release = resolve }))('services/api')
  const rejected = assert.rejects(api.apiRequest('/user/password', { method: 'PUT' }), obsolete)
  const epoch = api.beginAuthentication(); api.confirmAuthentication(epoch)
  release(json({ code: 'password_changed', reauthentication_required: true })); await rejected
  assert.equal(api.getAuthenticationGeneration(), epoch)
})
