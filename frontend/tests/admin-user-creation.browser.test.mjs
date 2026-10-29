import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// O transporte inteiro é substituído antes da aplicação iniciar; não acessa o banco real.
function transport() {
  const params = new URLSearchParams(location.search)
  window.userCreationTest = { boot: crypto.randomUUID(), posts: [], gets: [], csrfGets: 0, postStatus: 201, getStatus: 200, postDelay: 180, getDelay: 10,
    errors: { email: ['Já existe um usuário com esse e-mail.'] },
    rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Conta ${String(i).padStart(2, '0')}`, email: `conta${i}@example.invalid`, role: 'technician', disabled_at: null, created_at: '2026-10-27T12:00:00Z' })) }
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname, state = window.userCreationTest
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Administrador de teste', email: 'admin@example.invalid', role: params.get('role') || 'admin' })
    if (path === '/sanctum/csrf-cookie') { state.csrfGets++; document.cookie = 'XSRF-TOKEN=user-create-test'; return new Response(null, { status: 204 }) }
    if (path === '/api/admin/users' && options.method === 'POST') {
      const payload = JSON.parse(options.body)
      state.posts.push({ payload, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, state.postDelay))
      if (state.postStatus === 'offline') throw TypeError('Offline')
      if (state.postStatus === 204) return new Response(null, { status: 204 })
      if (state.postStatus !== 201) return json({ errors: state.errors, message: payload.password }, state.postStatus)
      const row = { id: 90, name: payload.name, email: payload.email, role: payload.role, disabled_at: null, created_at: '2026-10-27T13:00:00Z' }
      state.rows.push(row)
      return json({ data: row }, 201)
    }
    if (path === '/api/admin/users') {
      const query = Object.fromEntries(new URL(url).searchParams)
      state.gets.push(query)
      await new Promise(resolve => setTimeout(resolve, state.getDelay))
      if (state.getStatus !== 200) return json({}, state.getStatus)
      let rows = state.rows.filter(row => (!query.search || `${row.name} ${row.email}`.toLowerCase().includes(query.search.toLowerCase())) && (!query.role || row.role === query.role) && (!query.status || (row.disabled_at === null) === (query.status === 'active')))
      rows = rows.toSorted((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
      const total = rows.length, page = Number(query.page || 1), perPage = Number(query.per_page || 15), start = (page - 1) * perPage, last = Math.max(1, Math.ceil(total / perPage))
      rows = rows.slice(start, start + perPage)
      const link = p => `http://flowdesk.test/api/admin/users?page=${p}`
      return json({ data: rows, total, current_page: page, per_page: perPage, last_page: last, from: rows.length ? start + 1 : null, to: rows.length ? start + rows.length : null,
        first_page_url: link(1), last_page_url: link(last), next_page_url: page < last ? link(page + 1) : null, prev_page_url: page > 1 ? link(page - 1) : null, path: 'http://flowdesk.test/api/admin/users', links: [] })
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('cadastro administrativo de usuários no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (role = 'admin') => {
    const boot = await evaluate('window.userCreationTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}#/usuarios` })
    await wait(`!!window.userCreationTest && window.userCreationTest.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
    if (role === 'admin') await wait('document.querySelectorAll("tbody tr").length===15')
    else await wait('document.querySelector("h1")?.textContent==="Acesso não permitido"')
  }
  const ready = () => wait('document.querySelector("section[aria-labelledby=users-title]")?.getAttribute("aria-busy")==="false"')
  const button = text => evaluate(`[...document.querySelectorAll('main button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`)
  const input = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const open = async () => { await button('Novo usuário'); await wait('document.activeElement?.id==="user-create-name"') }
  const fill = async (role = 'requester') => {
    for (const [field, value] of Object.entries({ name: ' Pessoa Nova ', email: ' NOVO@Example.Invalid ', role, password: 'Senha!Segura123', password_confirmation: 'Senha!Segura123' })) await input(`#user-create-${field}`, value)
  }
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const closed = () => wait('!document.querySelector("#user-create-panel") && document.activeElement?.textContent==="Novo usuário"')
  try {
    await t.test('abre com foco, Cancelar e Escape descartam dados e restauram foco sem envio', async () => {
      await load(); await open(); await fill()
      await button('Cancelar'); await closed(); await open()
      assert.equal(await evaluate('document.querySelector("#user-create-password").value'), '')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await closed()
      assert.deepEqual(await evaluate('[userCreationTest.posts.length,userCreationTest.csrfGets]'), [0, 0])
    })
    await t.test('obrigatórios e perfil sem opção Administrador', async () => {
      await load(); await open(); await submit(); await wait('document.querySelectorAll("form [aria-invalid=true]").length===5')
      assert.equal(await evaluate('document.activeElement.id'), 'user-create-name')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#user-create-role option")].map(n=>n.value)'), ['', 'requester', 'technician'])
      assert.equal(await evaluate('[...document.querySelectorAll("form input,form select")].every(n=>n.required&&n.labels.length===1&&n.getAttribute("aria-describedby"))'), true)
      assert.equal(await evaluate('userCreationTest.posts.length'), 0)
    })
    await t.test('política de senha, bytes UTF-8 e confirmação impedem envio inválido', async () => {
      await load(); await open(); await fill()
      for (const password of ['', 'Aa1!', 'abcdefghijk1!', 'ABCDEFGHIJK1!', 'Abcdefghijkl!', 'Abcdefghijk12', 'Ab1!' + 'é'.repeat(35)]) {
        await input('#user-create-password', password); await input('#user-create-password_confirmation', password); await submit()
        await wait('document.querySelector("#user-create-password").getAttribute("aria-invalid")==="true"')
        assert.equal(await evaluate('document.activeElement.id'), 'user-create-password')
      }
      await input('#user-create-password', 'Senha!Segura123'); await input('#user-create-password_confirmation', 'Outra!Senha123'); await submit()
      await wait('document.querySelector("#user-create-password_confirmation").getAttribute("aria-invalid")==="true"')
      assert.equal(await evaluate('document.activeElement.id'), 'user-create-password_confirmation')
      assert.deepEqual(await evaluate('[userCreationTest.posts.length,userCreationTest.csrfGets]'), [0, 0])
    })
    for (const role of ['requester', 'technician']) await t.test(`${role}: cadastro, CSRF, atualização GET e descarte das senhas`, async () => {
      await load(); await open(); await fill(role); await submit(); await closed(); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Usuário cadastrado com sucesso/)
      assert.deepEqual(await evaluate('userCreationTest.posts'), [{ payload: { name: 'Pessoa Nova', email: 'novo@example.invalid', role, password: 'Senha!Segura123', password_confirmation: 'Senha!Segura123' }, credentials: 'include', csrf: 'user-create-test' }])
      assert.equal(await evaluate('userCreationTest.gets.length'), 2)
      assert.equal(await evaluate('!!document.querySelector("input[type=password]")'), false)
      await button('Localizar usuário cadastrado'); await ready()
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 1)
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Pessoa Nova')
      assert.equal(await evaluate('document.querySelector("main").textContent.includes("Senha!Segura123")'), false)
      assert.equal(await evaluate('JSON.stringify([Object.values(localStorage),Object.values(sessionStorage)]).includes("Senha!Segura123")'), false)
      await open(); assert.equal(await evaluate('document.querySelector("#user-create-password").value'), '')
    })
    await t.test('preserva pesquisa, perfil, situação e página; localização usa e-mail no servidor', async () => {
      await load(); await input('#user-search', 'Conta'); await ready(); await input('#user-role', 'technician'); await ready(); await input('#user-status', 'active'); await ready(); await button('Próxima'); await ready()
      const before = await evaluate('userCreationTest.gets.at(-1)')
      await open(); await fill(); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userCreationTest.gets.at(-1)'), before)
      assert.deepEqual(await evaluate('[document.querySelector("#user-search").value,document.querySelector("#user-role").value,document.querySelector("#user-status").value]'), ['Conta', 'technician', 'active'])
      await button('Localizar usuário cadastrado'); await ready()
      assert.deepEqual(await evaluate('userCreationTest.gets.at(-1)'), { page: '1', per_page: '15', search: 'novo@example.invalid' })
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Pessoa Nova')
    })
    await t.test('envios duplicados, Cancelar e Escape bloqueados durante processamento', async () => {
      await load(); await open(); await fill(); await evaluate('userCreationTest.postDelay=600')
      await submit(); await submit(); await wait('userCreationTest.posts.length===1')
      assert.equal(await evaluate('[...document.querySelectorAll("form input,form select,form button")].every(n=>n.disabled)'), true)
      assert.match(await evaluate('document.querySelector("button[type=submit]").textContent'), /Cadastrando/)
      await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      assert.equal(await evaluate('!!document.querySelector("form")'), true)
      await closed(); assert.equal(await evaluate('userCreationTest.posts.length'), 1)
    })
    for (const status of [401, 403, 419, 422, 503, 'offline', 200, 204]) await t.test(`erro ${status}: sem sucesso falso ou reenvio automático`, async () => {
      await load(); await open(); await fill(); await evaluate(`userCreationTest.postStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("#user-create-name").disabled')
      const text = await evaluate('document.querySelector("form").textContent')
      assert.equal(text.includes('Senha!Segura123'), false)
      if ([401, 419].includes(status)) assert.match(text, /sessão expirou/)
      else if (status === 403) assert.match(text, /permissão/)
      else if (status === 422) {
        assert.match(text, /Já existe um usuário com esse e-mail/)
        assert.equal(await evaluate('document.activeElement.id'), 'user-create-email')
        assert.equal(await evaluate('document.querySelector("#user-create-email").getAttribute("aria-describedby")'), 'user-create-email-error')
      } else assert.match(text, /Consulte a listagem/)
      assert.equal(await evaluate('document.querySelector("#user-create-name").value'), ' Pessoa Nova ')
      await button('Atualizar lista'); await ready()
      assert.equal(await evaluate('userCreationTest.posts.length'), 1)
    })
    await t.test('422 associa cada campo, oculta senha refletida e ignora atributos desconhecidos', async () => {
      await load(); await open(); await fill()
      await evaluate('userCreationTest.postStatus=422;userCreationTest.errors={name:["Nome inválido."],email:["E-mail inválido."],role:["Perfil inválido."],password:["Senha!Segura123 não é válida."],password_confirmation:["Confirmação inválida."],internal:["private-marker"]}')
      await submit(); await wait('document.querySelectorAll("form [aria-invalid=true]").length===5')
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("Senha!Segura123")'), false)
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'), false)
    })
    await t.test('falha GET após sucesso permite tentar novamente sem novo POST', async () => {
      await load(); await open(); await fill(); await evaluate('userCreationTest.getStatus=503'); await submit(); await closed(); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Usuário cadastrado com sucesso/)
      assert.equal(await evaluate('!!document.querySelector("form")'), false)
      await evaluate('userCreationTest.getStatus=200'); await button('Tentar novamente'); await ready()
      assert.equal(await evaluate('userCreationTest.posts.length'), 1)
      assert.equal(await evaluate('userCreationTest.gets.length'), 3)
    })
    for (const role of ['technician', 'requester']) await t.test(`${role}: cadastro indisponível por acesso direto`, async () => {
      await load(role)
      assert.equal(await evaluate('[...document.querySelectorAll("button")].some(n=>n.textContent==="Novo usuário")'), false)
      assert.deepEqual(await evaluate('[userCreationTest.gets.length,userCreationTest.posts.length]'), [0, 0])
    })
    await t.test('teclado, mostrar/ocultar senhas, rótulos e responsividade', async () => {
      await load(); await open(); await fill()
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'user-create-email')
      for (const [field, label] of [['password', 'senha inicial'], ['password_confirmation', 'confirmar senha']]) {
        assert.equal(await evaluate(`document.querySelector('#user-create-${field}').type`), 'password')
        await evaluate(`document.querySelector('button[aria-label="Mostrar ${label}"]').click()`)
        assert.equal(await evaluate(`document.querySelector('#user-create-${field}').type`), 'text')
        assert.equal(await evaluate(`document.querySelector('button[aria-label="Ocultar ${label}"]').getAttribute('aria-pressed')`), 'true')
        await evaluate(`document.querySelector('button[aria-label="Ocultar ${label}"]').click()`)
      }
      assert.equal(await evaluate('document.querySelector("#user-create-password").getAttribute("aria-describedby")'), 'user-password-help')
      for (const width of [320, 375, 768, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form select,form button")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
