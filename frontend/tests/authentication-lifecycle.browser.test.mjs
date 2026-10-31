import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// All traffic is simulated before startup, including deliberately uncancellable responses.
function transport() {
  const state = window.authTest = { boot: crypto.randomUUID(), authenticated: !new URLSearchParams(location.search).has('guest'),
    identity: { id: 1, name: 'Conta Original', email: 'original@example.invalid', role: 'admin' },
    loginStatus: 200, logoutStatus: 204, csrfStatus: 204, holdLogout: false, heldLogout: null, failurePath: '', failureStatus: 401, code: '',
    logins: 0, logouts: 0, slow: [], heldIdentity: null, holdIdentity: false, delivered: false, oldError: '' }
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    if (path === '/sanctum/csrf-cookie') {
      if (state.csrfStatus !== 204) return json({}, state.csrfStatus)
      document.cookie = 'XSRF-TOKEN=synthetic-csrf'
      return new Response(null, { status: 204 })
    }
    if (path === '/api/login') {
      state.logins++
      if (state.loginStatus !== 200) return json({}, state.loginStatus)
      state.authenticated = true
      return json(state.identity)
    }
    if (path === '/api/logout') {
      state.logouts++
      if (state.holdLogout) return new Promise(resolve => { state.heldLogout = () => resolve(new Response(null, { status: 204 })) })
      if (state.logoutStatus !== 204) return json({}, state.logoutStatus)
      state.authenticated = false
      return new Response(null, { status: 204 })
    }
    if (path === '/api/user') {
      if (state.holdIdentity) {
        state.holdIdentity = false
        const snapshot = { ...state.identity }
        return new Promise(resolve => { state.heldIdentity = () => resolve(json(snapshot)) })
      }
      return state.authenticated ? json(state.identity) : json({}, 401)
    }
    if (path.startsWith('/api/slow')) return new Promise(resolve => state.slow.push({ signal: options.signal,
      finish: (status, code = '') => resolve(status === 204 ? new Response(null, { status }) : json({ ...state.identity, code }, status)) }))
    if (path === state.failurePath) return json({ code: state.code }, state.failureStatus)
    if (path === '/api/user/password') return json({ code: 'password_changed', reauthentication_required: true })
    if (path === '/api/admin/users') {
      const rows = [{ ...state.identity }, { id: 90, name: 'Dado protegido', email: 'private@example.invalid', role: 'technician', disabled_at: null, created_at: null }]
        .map(row => ({ disabled_at: null, created_at: null, ...row }))
      return json({ data: rows, total: 2, current_page: 1, per_page: 15, last_page: 1, from: 1, to: 2,
        first_page_url: '', last_page_url: '', next_page_url: null, prev_page_url: null, path: '', links: [] })
    }
    throw Error('Unexpected mock request: '+path)
  }
}

test('ciclo de autenticação no navegador', { skip: !browserExecutable, timeout: 180000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (guest = false) => {
    const boot = await evaluate('window.authTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?case=${crypto.randomUUID()}${guest ? '&guest=1' : ''}#/usuarios` })
    await wait(`window.authTest?.boot && authTest.boot!==${JSON.stringify(boot)}`)
    await wait(guest ? '!!document.querySelector("#email") && !document.body.textContent.includes("Verificando")' : 'document.querySelectorAll("tbody tr").length===2')
  }
  const input = (id, value) => evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const login = async () => {
    await input('email', 'fresh@example.invalid'); await input('password', 'Synthetic!Password123')
    await evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await wait('document.querySelectorAll("tbody tr").length===2')
  }
  const fail = async (code = '', path = '/protected') => {
    await evaluate(`authTest.failurePath='/api'+${JSON.stringify(path)};authTest.failureStatus=401;authTest.code=${JSON.stringify(code)};import('/src/services/api.ts').then(api=>api.apiRequest(${JSON.stringify(path)})).catch(()=>{})`)
    await wait('!!document.querySelector("#email") && !document.querySelector("header")')
  }
  try {
    for (const code of ['', 'session_revoked']) await t.test(`401 ${code || 'genérico'} remove identidade e dados protegidos`, async () => {
      await load(); await fail(code)
      assert.match(await evaluate('document.body.textContent'), code ? /sessão foi revogada/ : /sessão expirou/)
      assert.equal(await evaluate('document.body.textContent.includes("Dado protegido")'), false)
      assert.equal(await evaluate('document.body.textContent.includes("Conta Original")'), false)
    })
    for (const status of [403, 419]) await t.test(`${status} não remove identidade nem página`, async () => {
      await load()
      await evaluate(`authTest.failurePath='/api/protected';authTest.failureStatus=${status};import('/src/services/api.ts').then(api=>api.apiRequest('/protected')).catch(()=>{authTest.done=true})`)
      await wait('authTest.done===true')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 2)
      assert.equal(await evaluate('!!document.querySelector("#email")'), false)
    })
    await t.test('login inválido permanece no formulário; novo login continua funcional', async () => {
      await load(true)
      assert.equal(await evaluate('document.body.textContent.includes("Sua sessão expirou")'), false)
      await evaluate('authTest.loginStatus=401')
      await input('email','fresh@example.invalid'); await input('password','Synthetic!Password123')
      await evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
      await wait('document.body.textContent.includes("E-mail ou senha inválidos")')
      assert.equal(await evaluate('authTest.logins'), 1)
      assert.equal(await evaluate('document.body.textContent.includes("sessão foi revogada")'), false)
      await evaluate('authTest.loginStatus=200'); await login()
    })
    for (const [status, code] of [[200,''], [401,''], [401,'session_revoked']]) await t.test(`resposta antiga ${status}/${code} não afeta novo login`, async () => {
      await load()
      await evaluate(`void import('/src/services/api.ts').then(api=>api.apiRequest('/slow')).then(()=>authTest.delivered=true,e=>authTest.oldError=e.name)`)
      await wait('authTest.slow.length===1')
      await fail()
      await evaluate('authTest.identity={id:2,name:"Conta Nova",email:"fresh@example.invalid",role:"admin"}')
      await login()
      await evaluate(`authTest.slow[0].finish(${status},${JSON.stringify(code)})`)
      await wait('authTest.oldError==="ObsoleteRequestError"')
      assert.equal(await evaluate('authTest.delivered'), false)
      assert.equal(await evaluate('document.querySelector("header [title]").getAttribute("title")'), 'Conta Nova')
    })
    await t.test('consulta de identidade antiga não é reaproveitada após novo login', async () => {
      await load()
      await evaluate('authTest.holdIdentity=true;void import("/src/services/auth.ts").then(auth=>auth.getCurrentUser()).then(()=>authTest.delivered=true,e=>authTest.oldError=e.name)')
      await wait('typeof authTest.heldIdentity==="function"'); await fail('session_revoked')
      await evaluate('authTest.identity={id:2,name:"Conta Nova",email:"fresh@example.invalid",role:"admin"}')
      await login(); await evaluate('authTest.heldIdentity()'); await wait('authTest.oldError==="ObsoleteRequestError"')
      assert.equal(await evaluate('document.querySelector("header [title]").getAttribute("title")'), 'Conta Nova')
    })
    await t.test('logout confirmado invalida resposta binária antiga e permite novo login', async () => {
      await load()
      await evaluate('void import("/src/services/api.ts").then(api=>api.apiBlobRequest("/slow-blob")).then(()=>authTest.delivered=true,e=>authTest.oldError=e.name)')
      await wait('authTest.slow.length===1')
      await evaluate(`document.querySelector('button[aria-label="Sair da conta"]').click()`)
      await wait('!!document.querySelector("#email") && !document.querySelector("header")')
      await evaluate('authTest.slow[0].finish(200)'); await wait('authTest.oldError==="ObsoleteRequestError"')
      assert.equal(await evaluate('authTest.delivered'), false); assert.equal(await evaluate('authTest.logouts'), 1)
      await login()
    })
    await t.test('conclusão de logout antigo não remove identidade do login novo', async () => {
      await load(); await evaluate('authTest.holdLogout=true')
      await evaluate(`document.querySelector('button[aria-label="Sair da conta"]').click()`)
      await wait('typeof authTest.heldLogout==="function"')
      await fail()
      await evaluate('authTest.identity={id:2,name:"Conta Nova",email:"fresh@example.invalid",role:"admin"}')
      await login(); await evaluate('authTest.heldLogout()')
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.equal(await evaluate('document.querySelector("header [title]").getAttribute("title")'), 'Conta Nova')
    })
    for (const csrf of [false, true]) for (const status of csrf ? [401, 403, 419] : [403, 419]) await t.test(`logout recusado ${status}/${csrf ? 'CSRF' : 'POST'} mantém sessão`, async () => {
      await load(); await evaluate(`authTest.${csrf ? 'csrfStatus' : 'logoutStatus'}=${status}`)
      await evaluate(`document.querySelector('button[aria-label="Sair da conta"]').click()`)
      await wait('document.body.textContent.includes("Não foi possível")')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 2)
    })
    await t.test('200 password_changed apresenta a mensagem prevista e exige novo login', async () => {
      await load()
      await evaluate('import("/src/services/api.ts").then(api=>api.apiRequest("/user/password",{method:"PUT"},200)).catch(()=>{})')
      await wait('!!document.querySelector("#email") && document.body.textContent.includes("Senha alterada. Entre novamente com a nova senha.")')
      assert.equal(await evaluate('!!document.querySelector("tbody")'), false)
      await login()
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
