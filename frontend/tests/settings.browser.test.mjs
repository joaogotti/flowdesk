import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Every request is simulated before startup; no backend or database is contacted.
function transport() {
  const params = new URLSearchParams(location.search)
  const state = window.settingsTest = { boot: crypto.randomUUID(), authenticated: true,
    identity: { id: 8, name: 'Nome Original', email: 'conta@example.invalid', role: params.get('role') || 'admin' },
    userGets: 0, csrfGets: 0, getStatus: Number(params.get('getStatus') || 200), csrfStatus: 204,
    profileStatus: 200, profileCode: '', passwordStatus: 200, passwordCode: '',
    errors: {}, profileRequests: [], passwordRequests: [], logouts: 0,
    holdProfile: false, holdPassword: false, holdIdentity: false, heldProfile: null, heldPassword: null, heldIdentity: null }
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
  const failure = (status, code = '') => json({ code, errors: state.errors }, status)
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus !== 204) return failure(state.csrfStatus)
      document.cookie = 'XSRF-TOKEN=settings-synthetic-csrf'
      return new Response(null, { status: 204 })
    }
    if (path === '/api/user') {
      state.userGets++
      if (!state.authenticated) return failure(401)
      if (state.holdIdentity) {
        state.holdIdentity = false
        const snapshot = { ...state.identity }
        return new Promise(resolve => { state.heldIdentity = () => resolve(json(snapshot)) })
      }
      if (state.userGets > 1 && state.getStatus !== 200) return failure(state.getStatus)
      return json(state.identity)
    }
    if (path === '/api/user/profile') {
      const payload = JSON.parse(options.body)
      state.profileRequests.push({ payload, method: options.method, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      if (state.holdProfile) {
        const snapshot = { ...state.identity, name: payload.name }
        return new Promise(resolve => { state.heldProfile = () => resolve(json({ data: snapshot })) })
      }
      if (state.profileStatus !== 200) return failure(state.profileStatus, state.profileCode)
      if (payload.expected_name !== state.identity.name) return failure(409, 'profile_changed')
      state.identity.name = payload.name
      return json({ data: state.identity })
    }
    if (path === '/api/user/password') {
      state.passwordRequests.push({ payload: JSON.parse(options.body), method: options.method, csrf: options.headers.get('X-XSRF-TOKEN') })
      if (state.holdPassword) return new Promise(resolve => { state.heldPassword = () => resolve(json({ code: 'password_changed', reauthentication_required: true })) })
      if (state.passwordStatus !== 200) return failure(state.passwordStatus, state.passwordCode)
      state.authenticated = false
      return json({ code: 'password_changed', reauthentication_required: true })
    }
    if (path === '/api/logout') {
      state.logouts++; state.authenticated = false
      return new Response(null, { status: 204 })
    }
    if (path === '/api/login') { state.authenticated = true; return json(state.identity) }
    if (path === '/api/test-expired') return failure(401)
    if (path === '/api/categories') return json({ data: [] })
    throw Error('Unexpected request: ' + path)
  }
}

test('Configurações no navegador', { skip: !browserExecutable, timeout: 180000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { send, evaluate, wait } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (role = 'admin', getStatus = 200) => {
    const boot = await evaluate('window.settingsTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&getStatus=${getStatus}&test=${crypto.randomUUID()}#/configuracoes` })
    await wait(`window.settingsTest?.boot && settingsTest.boot!==${JSON.stringify(boot)} && document.querySelector('h1')?.textContent==='Configurações'`)
    await wait(getStatus === 200 ? '!!document.querySelector("#settings-name")' : 'document.body.textContent.includes("Tentar novamente")')
  }
  const input = (id, value) => evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const submit = (form = 'profile') => evaluate(`document.querySelector('#settings-${form}-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
  const fillPassword = async (current = ' SenhaAtual!123 ', next = ' NovaSenha!Segura456 ', confirmation = next) => {
    await input('settings-current_password', current); await input('settings-password', next); await input('settings-password_confirmation', confirmation)
  }
  const ready = (form = 'profile') => wait(`document.querySelector('#settings-${form}-form')?.getAttribute('aria-busy')==='false'`)
  const button = label => evaluate(`[...document.querySelectorAll('main button')].find(node=>node.textContent===${JSON.stringify(label)}).click()`)
  const relogin = async () => {
    await input('email', 'nova@example.invalid'); await input('password', 'Synthetic!Password123')
    await evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await wait('!!document.querySelector("#settings-name")')
  }
  const loseAuthentication = async () => {
    await evaluate('void import("/src/services/api.ts").then(api=>api.apiRequest("/test-expired")).catch(()=>{})')
    await wait('!!document.querySelector("#email") && !document.querySelector("#settings-name")')
  }
  try {
    for (const role of ['requester', 'technician', 'admin']) await t.test(`${role}: acesso, identidade atualizada, navegação e campos somente leitura`, async () => {
      await load(role)
      assert.equal(await evaluate('settingsTest.userGets'), 2)
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Nome Original')
      assert.deepEqual(await evaluate('["settings-email","settings-role"].map(id=>document.getElementById(id).readOnly)'), [true, true])
      assert.equal(await evaluate('document.querySelector("#settings-email").value'), 'conta@example.invalid')
      assert.equal(await evaluate(`document.querySelector('aside a[href="#/configuracoes"]').getAttribute('aria-current')`), 'page')
      assert.equal(await evaluate(`document.querySelector('aside a[href="#/configuracoes"]').textContent.includes('Em breve')`), false)
      assert.equal(await evaluate('!!document.querySelector("#settings-admin-title")'), role === 'admin')
      assert.equal(await evaluate('document.querySelectorAll("main a[href*=usuarios],main a[href*=categorias]").length'), role === 'admin' ? 2 : 0)
    })

    await t.test('nome alterado atualiza identidade e envia apenas o contrato permitido', async () => {
      await load(); await input('settings-name', '  Nome Atualizado  '); await submit()
      await wait('document.body.textContent.includes("Nome atualizado com sucesso.")')
      assert.deepEqual(await evaluate('settingsTest.profileRequests[0]'), { payload: { name: 'Nome Atualizado', expected_name: 'Nome Original' }, method: 'PATCH', credentials: 'include', csrf: 'settings-synthetic-csrf' })
      assert.equal(await evaluate('document.querySelector("header [title]").title'), 'Nome Atualizado')
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Nome Atualizado')
      await submit(); assert.equal(await evaluate('settingsTest.profileRequests.length'), 1)
    })

    await t.test('nome inalterado e vazio não enviam gravação; validação tem foco', async () => {
      await load(); await submit(); assert.equal(await evaluate('settingsTest.profileRequests.length'), 0)
      await input('settings-name', '   '); await submit()
      await wait('document.querySelector("#settings-name-error")?.textContent.includes("Informe")')
      assert.equal(await evaluate('document.activeElement.id'), 'settings-name')
      assert.equal(await evaluate('settingsTest.profileRequests.length'), 0)
    })

    await t.test('409 preserva rascunho; atualizar carrega precondição e permite revisão/reenvio', async () => {
      await load(); await input('settings-name', 'Meu Rascunho')
      await evaluate('settingsTest.identity.name="Nome de Outra Sessão"'); await submit(); await ready()
      assert.match(await evaluate('document.body.textContent'), /modificados por outra sessão/)
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Meu Rascunho')
      await submit(); assert.equal(await evaluate('settingsTest.profileRequests.length'), 1)
      await button('Atualizar dados')
      await wait('document.body.textContent.includes("Nome atual: Nome de Outra Sessão")')
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Meu Rascunho')
      await submit(); await wait('document.body.textContent.includes("Nome atualizado com sucesso.")')
      assert.deepEqual(await evaluate('settingsTest.profileRequests[1].payload'), { name: 'Meu Rascunho', expected_name: 'Nome de Outra Sessão' })
    })

    await t.test('falha ao atualizar conflito não substitui rascunho ou precondição', async () => {
      await load(); await input('settings-name', 'Meu Rascunho'); await evaluate('settingsTest.identity.name="Outro Nome"'); await submit(); await ready()
      await evaluate('settingsTest.getStatus=503'); await button('Atualizar dados'); await ready()
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Meu Rascunho')
      await submit(); assert.equal(await evaluate('settingsTest.profileRequests.length'), 1)
      await evaluate('settingsTest.getStatus=200'); await button('Atualizar dados')
      await wait('document.body.textContent.includes("Nome atual: Outro Nome")')
    })

    for (const status of [403, 419, 422, 429, 503]) await t.test(`perfil ${status}: sessão e rascunho preservados`, async () => {
      await load(); await input('settings-name', 'Meu Rascunho')
      await evaluate(`settingsTest.profileStatus=${status};settingsTest.errors={name:['Nome rejeitado pelo servidor.']}`)
      await submit(); await ready()
      await wait('!!document.querySelector("#settings-profile-form [role=alert]")')
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Meu Rascunho')
      assert.equal(await evaluate('document.querySelector("header [title]").title'), 'Nome Original')
      if (status === 422) assert.equal(await evaluate('document.querySelector("#settings-name-error").textContent'), 'Nome rejeitado pelo servidor.')
    })

    for (const form of ['profile', 'password']) for (const code of ['', 'session_revoked']) await t.test(`${form} 401 ${code || 'genérico'} limpa página e identidade`, async () => {
      await load()
      if (form === 'profile') await input('settings-name', 'Rascunho Privado')
      else await fillPassword()
      await evaluate(`settingsTest.${form}Status=401;settingsTest.${form}Code=${JSON.stringify(code)}`)
      await submit(form); await wait('!!document.querySelector("#email") && !document.querySelector("header")')
      assert.match(await evaluate('document.body.textContent'), code ? /sessão foi revogada/ : /sessão expirou/)
      assert.equal(await evaluate('document.body.textContent.includes("Rascunho Privado")'), false)
    })

    await t.test('duplo submit de nome envia somente um PATCH', async () => {
      await load(); await input('settings-name', 'Novo Nome'); await evaluate('settingsTest.holdProfile=true')
      await evaluate('(()=>{const form=document.querySelector("#settings-profile-form");for(let i=0;i<2;i++)form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))})()')
      await wait('typeof settingsTest.heldProfile==="function"')
      assert.equal(await evaluate('settingsTest.profileRequests.length'), 1)
      assert.equal(await evaluate('document.querySelector("#settings-name").disabled'), true)
      await evaluate('settingsTest.heldProfile()'); await ready()
    })

    await t.test('senha: labels, autocomplete, requisitos e validação de campos vazios', async () => {
      await load(); await submit('password')
      await wait('document.querySelectorAll("#settings-password-form input[aria-invalid=true]").length===3')
      assert.equal(await evaluate('document.activeElement.id'), 'settings-current_password')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#settings-password-form input")].map(n=>[n.type,n.autocomplete,n.labels.length])'), [['password','current-password',1],['password','new-password',1],['password','new-password',1]])
      assert.match(await evaluate('document.querySelector("#settings-password-help").textContent'), /12 caracteres.*maiúscula.*minúscula.*número.*símbolo.*72 bytes/)
      assert.equal(await evaluate('settingsTest.passwordRequests.length'), 0)
    })

    for (const [next, confirmation, pattern] of [
      ['fraca', 'fraca', /12 caracteres/],
      ['NovaSenha!Segura456', 'OutraSenha!123', /não corresponde/],
      ['Á'.repeat(35)+'a1!', 'Á'.repeat(35)+'a1!', /72 bytes/],
      [' SenhaAtual!123 ', ' SenhaAtual!123 ', /diferente/],
    ]) await t.test(`senha: validação local ${pattern}`, async () => {
      await load(); await fillPassword(' SenhaAtual!123 ', next, confirmation); await submit('password')
      await wait('!!document.querySelector("#settings-password-form [role=alert]")')
      assert.match(await evaluate('document.querySelector("#settings-password-form").textContent'), pattern)
      assert.equal(await evaluate('settingsTest.passwordRequests.length'), 0)
    })

    for (const status of [403, 419, 422, 429, 503]) await t.test(`senha ${status}: erro acessível e sessão preservada`, async () => {
      await load(); await fillPassword()
      await evaluate(`settingsTest.passwordStatus=${status};settingsTest.errors={current_password:['A senha atual está incorreta.']}`)
      await submit('password'); await ready('password')
      await wait('!!document.querySelector("#settings-password-form [role=alert]")')
      assert.equal(await evaluate('!!document.querySelector("header")'), true)
      if (status === 422) {
        assert.equal(await evaluate('document.activeElement.id'), 'settings-current_password')
        assert.match(await evaluate('document.querySelector("#settings-current_password-error").textContent'), /incorreta/)
      }
      if (status === 429) assert.match(await evaluate('document.querySelector("#settings-password-form").textContent'), /Muitas tentativas/)
    })

    await t.test('senha: espaços preservados, duplo submit bloqueado, sucesso exige novo login', async () => {
      await load(); await fillPassword(); await evaluate('settingsTest.holdPassword=true;void (window.detachedPasswords=[...document.querySelectorAll("#settings-password-form input")])')
      await evaluate('(()=>{const form=document.querySelector("#settings-password-form");for(let i=0;i<2;i++)form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))})()')
      await wait('typeof settingsTest.heldPassword==="function"')
      assert.equal(await evaluate('settingsTest.passwordRequests.length'), 1)
      assert.deepEqual(await evaluate('settingsTest.passwordRequests[0].payload'), { current_password: ' SenhaAtual!123 ', password: ' NovaSenha!Segura456 ', password_confirmation: ' NovaSenha!Segura456 ' })
      assert.equal(await evaluate('[...document.querySelectorAll("#settings-password-form input")].every(n=>n.disabled)'), true)
      await evaluate('settingsTest.heldPassword()')
      await wait('!!document.querySelector("#email") && document.body.textContent.includes("Senha alterada. Entre novamente com a nova senha.")')
      assert.equal(await evaluate('detachedPasswords.every(n=>n.value==="")'), true)
      assert.equal(await evaluate('settingsTest.logouts'), 0)
      assert.equal(await evaluate('localStorage.length+sessionStorage.length'), 0)
      await evaluate('settingsTest.holdPassword=false;settingsTest.identity.name="Nome Após Login"')
      await relogin(); assert.equal(await evaluate('document.querySelector("header [title]").title'), 'Nome Após Login')
    })

    await t.test('desmontar a página limpa senhas e não mantém rascunhos na volta', async () => {
      await load('requester'); await fillPassword()
      await evaluate('window.detachedPasswords=[...document.querySelectorAll("#settings-password-form input")];location.hash="#/categorias"')
      await wait('!document.querySelector("#settings-password-form")')
      assert.equal(await evaluate('detachedPasswords.every(n=>n.value==="")'), true)
      await evaluate('location.hash="#/configuracoes"'); await wait('!!document.querySelector("#settings-password-form")')
      assert.equal(await evaluate('[...document.querySelectorAll("#settings-password-form input")].every(n=>n.value==="")'), true)
      assert.equal(await evaluate('settingsTest.userGets'), 3)
    })

    for (const operation of ['profile', 'password', 'identity']) await t.test(`${operation}: resposta antiga não restaura dados nem derruba login novo`, async () => {
      await load()
      if (operation === 'identity') {
        await input('settings-name', 'Rascunho'); await evaluate('settingsTest.identity.name="Outro Nome"'); await submit(); await ready()
        await evaluate('settingsTest.holdIdentity=true'); await button('Atualizar dados')
      } else {
        await evaluate(`settingsTest.hold${operation === 'profile' ? 'Profile' : 'Password'}=true`)
        if (operation === 'profile') await input('settings-name', 'Resposta Antiga')
        else await fillPassword()
        await submit(operation)
      }
      const resolver = 'held'+operation[0].toUpperCase()+operation.slice(1)
      await wait(`typeof settingsTest.${resolver}==='function'`)
      await loseAuthentication()
      await evaluate('settingsTest.identity={id:9,name:"Conta Nova",email:"nova@example.invalid",role:"requester"}')
      await relogin(); await evaluate(`settingsTest.${resolver}()`)
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.equal(await evaluate('document.querySelector("header [title]").title'), 'Conta Nova')
      assert.equal(await evaluate('document.querySelector("#settings-name").value'), 'Conta Nova')
      assert.equal(await evaluate('!!document.querySelector("#settings-admin-title")'), false)
      assert.equal(await evaluate('[...document.querySelectorAll("#settings-password-form input")].every(n=>n.value==="")'), true)
    })

    await t.test('falha da consulta inicial permite tentar novamente sem usar dados antigos', async () => {
      await load('admin', 403)
      assert.equal(await evaluate('!!document.querySelector("#settings-name")'), false)
      assert.equal(await evaluate('!!document.querySelector("header")'), true)
      await evaluate('settingsTest.getStatus=200'); await button('Tentar novamente')
      await wait('!!document.querySelector("#settings-name")')
    })

    await t.test('CSRF recusado não envia senha e mantém identidade', async () => {
      await load(); await fillPassword(); await evaluate('settingsTest.csrfStatus=419'); await submit('password'); await ready('password')
      await wait('!!document.querySelector("#settings-password-form [role=alert]")')
      assert.equal(await evaluate('settingsTest.passwordRequests.length'), 0)
      assert.equal(await evaluate('!!document.querySelector("header")'), true)
    })

    await t.test('responsividade, menu mobile, labels, landmarks e navegação por teclado', async () => {
      await load()
      for (const width of [320, 375, 768, 1024, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))')
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `overflow ${width}`)
        assert.equal(await evaluate('[...document.querySelectorAll("main input")].every(n=>n.labels.length===1 && n.getBoundingClientRect().width>0)'), true)
      }
      await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false })
      await evaluate(`document.querySelector('button[aria-controls="workspace-navigation"]').click()`)
      assert.equal(await evaluate('document.querySelector("#workspace-navigation").getBoundingClientRect().height>0'), true)
      await evaluate(`document.querySelector('aside a[href="#/configuracoes"]').click()`)
      assert.equal(await evaluate(`document.querySelector('button[aria-controls="workspace-navigation"]').getAttribute('aria-expanded')`), 'false')
      await evaluate('document.querySelector("#settings-name").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'settings-email')
      assert.equal(await evaluate('document.querySelectorAll("main h1").length'), 1)
      assert.equal(await evaluate('document.querySelectorAll("main section[aria-labelledby]").length'), 3)
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
