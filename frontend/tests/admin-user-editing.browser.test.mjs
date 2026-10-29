import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Intercepts every request before startup. No request reaches Laravel or PostgreSQL.
function transport() {
  const params = new URLSearchParams(location.search)
  window.userEditTest = { boot: crypto.randomUUID(), patches: [], gets: [], csrfGets: 0, userGets: 0,
    patchStatus: 200, csrfStatus: 204, getStatus: 200, patchDelay: 100, getDelay: 10,
    errors: { email: ['Já existe um usuário com esse e-mail.'] },
    rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Conta ${String(i).padStart(2, '0')}`, email: `conta${i + 1}@example.invalid`,
      role: i === 0 ? 'admin' : i === 2 ? 'requester' : 'technician', disabled_at: i === 2 ? '2026-10-01T12:00:00Z' : null, created_at: '2026-10-27T12:00:00Z' })) }
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname, state = window.userEditTest
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') { state.userGets++; return json({ ...state.rows[0], role: params.get('role') || 'admin' }) }
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      if (state.csrfStatus !== 204) return json({}, state.csrfStatus)
      document.cookie = 'XSRF-TOKEN=user-edit-test'
      return new Response(null, { status: 204 })
    }
    if (/^\/api\/admin\/users\/\d+$/.test(path) && options.method === 'PATCH') {
      const id = Number(path.split('/').at(-1)), payload = JSON.parse(options.body)
      state.patches.push({ id, payload, method: options.method, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, state.patchDelay))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus === 204) return new Response(null, { status: 204 })
      if (state.patchStatus === 'invalid') return json({ data: { id } })
      if (state.patchStatus !== 200) return json({ errors: state.errors }, state.patchStatus)
      const row = state.rows.find(row => row.id === id)
      Object.assign(row, payload)
      return json({ data: row })
    }
    if (path === '/api/admin/users' && options.method === 'GET') {
      const query = Object.fromEntries(new URL(url).searchParams)
      state.gets.push(query)
      await new Promise(resolve => setTimeout(resolve, state.getDelay))
      if (state.getStatus === 'offline') throw TypeError('Offline')
      if (state.getStatus !== 200) return json({}, state.getStatus)
      let rows = state.rows.filter(row => (!query.search || `${row.name} ${row.email}`.toLowerCase().includes(query.search.toLowerCase())) && (!query.role || row.role === query.role) && (!query.status || (row.disabled_at === null) === (query.status === 'active')))
      rows = rows.toSorted((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
      const total = rows.length, page = Number(query.page || 1), perPage = Number(query.per_page || 15), start = (page - 1) * perPage, last = Math.max(1, Math.ceil(total / perPage))
      rows = rows.slice(start, start + perPage)
      const link = p => `http://flowdesk.test/api/admin/users?page=${p}`
      return json({ data: rows, total, current_page: page, per_page: perPage, last_page: last, from: rows.length ? start + 1 : null, to: rows.length ? start + rows.length : null,
        first_page_url: link(1), last_page_url: link(last), next_page_url: page < last ? link(page + 1) : null, prev_page_url: page > 1 ? link(page - 1) : null, path: 'http://flowdesk.test/api/admin/users', links: [] })
    }
    throw Error(`Unexpected request: ${options.method} ${path}`)
  }
}

test('edição administrativa de usuários no navegador', { skip: !browserExecutable, timeout: 180000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (role = 'admin') => {
    const boot = await evaluate('window.userEditTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}#/usuarios` })
    await wait(`!!window.userEditTest && window.userEditTest.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
    if (role === 'admin') await wait('document.querySelectorAll("tbody tr").length===15')
    else await wait('document.querySelector("h1")?.textContent==="Acesso não permitido"')
  }
  const ready = () => wait('document.querySelector("section[aria-labelledby=users-title]")?.getAttribute("aria-busy")==="false"')
  const button = label => evaluate(`[...document.querySelectorAll('main button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  const input = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const open = async (index = 1) => { await evaluate(`document.querySelectorAll('tbody button[aria-label^=Editar]')[${index}].click()`); await wait('document.activeElement?.id==="user-edit-name"') }
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const closed = () => wait('!document.querySelector("#user-edit-panel")')
  try {
    await t.test('abre preenchido, identifica usuário e oferece apenas nome e e-mail', async () => {
      await load(); await open()
      assert.deepEqual(await evaluate('[...document.querySelectorAll("form input")].map(n=>[n.name,n.value])'), [['name', 'Conta 01'], ['email', 'conta2@example.invalid']])
      assert.match(await evaluate('document.querySelector("#user-edit-description").textContent'), /Conta 01.*conta2@example.invalid.*ID 2/)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("form input")].map(n=>[n.required,n.maxLength,n.labels.length])'), [[true,255,1],[true,255,1]])
      assert.equal(await evaluate('[...document.querySelectorAll("tbody button")].every(n=>n.disabled)'), true)
      assert.equal(await evaluate('[...document.querySelectorAll("main button")].find(n=>n.textContent==="Novo usuário").disabled'), true)
    })
    for (const escape of [false, true]) await t.test(`cancelamento ${escape ? 'Escape' : 'botão'} descarta rascunho e restaura foco`, async () => {
      await load(); await open(); await input('#user-edit-name', 'Rascunho')
      if (escape) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      } else await button('Cancelar')
      await wait('!document.querySelector("form") && document.activeElement?.getAttribute("aria-label")==="Editar usuário Conta 01"')
      assert.deepEqual(await evaluate('[userEditTest.patches.length,userEditTest.csrfGets]'), [0,0])
      await open(); assert.equal(await evaluate('document.querySelector("#user-edit-name").value'), 'Conta 01')
    })
    await t.test('dados inalterados, espaços externos e caixa do e-mail não enviam PATCH ou CSRF', async () => {
      await load(); await open(); await submit()
      await input('#user-edit-name', '\u200b Conta 01\u00a0'); await input('#user-edit-email', ' CONTA2@EXAMPLE.INVALID '); await submit()
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true)
      await input('#user-edit-name', 'Rascunho'); await input('#user-edit-name', 'Conta 01'); await submit()
      assert.deepEqual(await evaluate('[userEditTest.patches.length,userEditTest.csrfGets]'), [0,0])
    })
    for (const [label, values, payload] of [
      ['nome', { name: ' Conta 01 Editada ' }, { name: 'Conta 01 Editada' }],
      ['e-mail', { email: ' NOVO@Example.Invalid ' }, { email: 'novo@example.invalid' }],
      ['ambos', { name: ' Conta 01 Editada ', email: ' NOVO@Example.Invalid ' }, { name: 'Conta 01 Editada', email: 'novo@example.invalid' }],
    ]) await t.test(`${label}: envia somente mudanças, atualiza tabela e restaura foco após GET`, async () => {
      await load(); await open()
      for (const [field,value] of Object.entries(values)) await input(`#user-edit-${field}`, value)
      await evaluate('userEditTest.getDelay=250'); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userEditTest.patches'), [{ id: 2, payload, method: 'PATCH', credentials: 'include', csrf: 'user-edit-test' }])
      assert.equal(await evaluate('userEditTest.gets.length'), 2)
      assert.match(await evaluate('document.querySelector("main").textContent'), /Usuário alterado com sucesso/)
      assert.match(await evaluate('document.querySelector("tbody").textContent'), /Conta 01/)
      if (payload.email) assert.match(await evaluate('document.querySelector("tbody").textContent'), /novo@example.invalid/)
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `Editar usuário ${payload.name || 'Conta 01'}`)
      assert.equal(await evaluate('document.querySelector("header [title]").getAttribute("title")'), 'Conta 00')
    })
    await t.test('preserva pesquisa, perfil, situação e página 2', async () => {
      await load()
      for (const [selector, value] of [['#user-search','Conta'],['#user-role','technician'],['#user-status','active']]) {
        const count = await evaluate('userEditTest.gets.length')
        await input(selector, value); await wait(`userEditTest.gets.length>${count}`); await ready()
      }
      await button('Próxima'); await wait('userEditTest.gets.at(-1).page==="2"'); await ready()
      const before = await evaluate('userEditTest.gets.at(-1)')
      await open(0); await input('#user-edit-email', 'changed@example.invalid'); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userEditTest.gets.at(-1)'), before)
      assert.deepEqual(await evaluate('[document.querySelector("#user-search").value,document.querySelector("#user-role").value,document.querySelector("#user-status").value]'), ['Conta','technician','active'])
      assert.match(await evaluate(`document.querySelector('nav[aria-label="Paginação de usuários"]').textContent`), /Página 2/)
    })
    await t.test('usuário deixa de corresponder à pesquisa: mantém filtro e usa foco alternativo', async () => {
      await load(); await input('#user-search','conta2@example.invalid'); await wait('document.querySelectorAll("tbody tr").length===1')
      await open(0); await input('#user-edit-email','other@example.invalid'); await submit(); await closed(); await ready()
      assert.equal(await evaluate('document.querySelector("#user-search").value'), 'conta2@example.invalid')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 0)
      assert.equal(await evaluate('document.activeElement.id'), 'users-title')
    })
    await t.test('página deixa de existir após edição: volta à última página mantendo filtro', async () => {
      await load(); await evaluate('userEditTest.rows=userEditTest.rows.slice(0,16)'); await button('Atualizar lista'); await ready()
      await input('#user-search','Conta'); await wait('userEditTest.gets.at(-1).search==="Conta"'); await ready()
      await button('Próxima'); await wait('document.querySelectorAll("tbody tr").length===1')
      await open(0); await input('#user-edit-name','Nome Fora da Pesquisa'); await input('#user-edit-email','outside@example.invalid'); await submit(); await closed()
      await wait('userEditTest.gets.at(-1).page==="1" && document.querySelectorAll("tbody tr").length===15')
      assert.equal(await evaluate('document.querySelector("#user-search").value'), 'Conta')
      assert.equal(await evaluate('userEditTest.patches.length'), 1)
    })
    await t.test('próprio administrador atualiza cabeçalho e iniciais sem logout ou nova autenticação', async () => {
      await load(); await open(0)
      await input('#user-edit-name','Admin Atualizado'); await input('#user-edit-email',' ADMIN.NOVO@Example.Invalid ')
      await submit(); await closed(); await ready()
      assert.equal(await evaluate('document.querySelector("header [title]").getAttribute("title")'), 'Admin Atualizado')
      assert.match(await evaluate('document.querySelector("header").textContent'), /AA.*Admin Atualizado/)
      assert.deepEqual(await evaluate('userEditTest.patches[0].payload'), { name: 'Admin Atualizado', email: 'admin.novo@example.invalid' })
      assert.equal(await evaluate('userEditTest.rows[0].role'), 'admin')
      assert.equal(await evaluate('userEditTest.userGets'), 1)
      await open(0); assert.equal(await evaluate('document.querySelector("#user-edit-email").value'), 'admin.novo@example.invalid')
    })
    await t.test('conta desativada mantém situação e perfil', async () => {
      await load(); await open(2); await input('#user-edit-email','disabled@example.invalid'); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userEditTest.rows.find(r=>r.id===3)'), { id: 3, name: 'Conta 02', email: 'disabled@example.invalid', role: 'requester', disabled_at: '2026-10-01T12:00:00Z', created_at: '2026-10-27T12:00:00Z' })
    })
    await t.test('inválidos e NUL no início, meio e fim: erros locais sem rede', async () => {
      await load(); await open()
      for (const [field, value] of [['name',''],['name','  '],['name','a'.repeat(256)],['name','A\0B'],['email',''],['email','inválido'],['email','\0new@example.invalid'],['email','ne\0w@example.invalid'],['email','new@example.invalid\0']]) {
        await input('#user-edit-name','Conta 01'); await input('#user-edit-email','conta2@example.invalid')
        await input(`#user-edit-${field}`,value); await submit()
        await wait(`document.querySelector('#user-edit-${field}').getAttribute('aria-invalid')==='true'`)
        assert.equal(await evaluate('document.activeElement.id'), `user-edit-${field}`)
        assert.equal(await evaluate(`document.querySelector('#user-edit-${field}').getAttribute('aria-describedby')`), `user-edit-${field}-error`)
      }
      assert.deepEqual(await evaluate('[userEditTest.patches.length,userEditTest.csrfGets]'), [0,0])
    })
    await t.test('processamento bloqueia campos, cancelamento e envios duplicados', async () => {
      await load(); await open(); await input('#user-edit-name','Novo Nome'); await evaluate('userEditTest.patchDelay=500')
      await evaluate('const f=document.querySelector("form");f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));')
      await wait('userEditTest.patches.length===1')
      assert.equal(await evaluate('[...document.querySelectorAll("form input,form button")].every(n=>n.disabled)'), true)
      assert.equal(await evaluate('document.querySelector("form").getAttribute("aria-busy")'), 'true')
      await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      assert.equal(await evaluate('!!document.querySelector("form")'), true)
      await closed(); await ready(); assert.equal(await evaluate('userEditTest.patches.length'), 1)
    })
    for (const status of [401,403,404,419,422,503,'offline',201,204,'invalid']) await t.test(`PATCH ${status}: mantém rascunho e não reenvia automaticamente`, async () => {
      await load(); await open(); await input('#user-edit-email','duplicate@example.invalid')
      await evaluate(`userEditTest.patchStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("#user-edit-email").disabled')
      assert.match(await evaluate('document.querySelector("form").textContent'), [401,419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /Já existe um usuário/ : /Consulte a listagem/)
      assert.equal(await evaluate('document.querySelector("#user-edit-email").value'), 'duplicate@example.invalid')
      if (status === 422) assert.equal(await evaluate('document.activeElement.id'), 'user-edit-email')
      else assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'alert')
      assert.equal(await evaluate('userEditTest.gets.length'), 1)
      await button('Atualizar lista'); await ready()
      assert.equal(await evaluate('userEditTest.patches.length'), 1)
    })
    await t.test('422 associa ambos os campos, ignora campos internos e aceita correção explícita', async () => {
      await load(); await open(); await input('#user-edit-name','Outro'); await input('#user-edit-email','other@example.invalid')
      await evaluate('userEditTest.patchStatus=422;userEditTest.errors={name:["Nome inválido."],email:["E-mail inválido."],internal:["private-marker"]}')
      await submit(); await wait('document.querySelectorAll("form [aria-invalid=true]").length===2')
      assert.equal(await evaluate('document.activeElement.id'), 'user-edit-name')
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'), false)
      await input('#user-edit-name','Corrigido'); await input('#user-edit-email','corrected@example.invalid'); await evaluate('userEditTest.patchStatus=200'); await submit(); await closed(); await ready()
      assert.equal(await evaluate('userEditTest.patches.length'), 2)
    })
    for (const status of [401,419,'offline']) await t.test(`CSRF ${status}: não envia PATCH`, async () => {
      await load(); await open(); await input('#user-edit-name','Outro'); await evaluate(`userEditTest.csrfStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('userEditTest.patches.length'), 0)
    })
    await t.test('falha no GET após salvar: sucesso mantido, foco no retry e nova tentativa somente de GET', async () => {
      await load(); await open(); await input('#user-edit-name','Outro'); await evaluate('userEditTest.getStatus=503'); await submit(); await closed(); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Usuário alterado com sucesso/)
      assert.equal(await evaluate('document.activeElement.textContent'), 'Tentar novamente')
      await evaluate('userEditTest.getStatus=200'); await button('Tentar novamente'); await ready()
      assert.equal(await evaluate('userEditTest.patches.length'), 1)
      assert.equal(await evaluate('userEditTest.gets.length'), 3)
    })
    for (const role of ['technician','requester']) await t.test(`${role}: sem acesso à edição`, async () => {
      await load(role)
      assert.deepEqual(await evaluate('[userEditTest.gets.length,userEditTest.patches.length]'), [0,0])
      assert.equal(await evaluate('document.querySelectorAll("form,tbody button").length'), 0)
    })
    await t.test('teclado, nomes acessíveis e responsividade de 320 a 1440px', async () => {
      await load(); await evaluate('document.querySelectorAll("tbody button")[1].focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await wait('document.activeElement?.id==="user-edit-name"')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'user-edit-email')
      assert.equal(await evaluate('document.querySelector("form").getAttribute("aria-labelledby")'), 'user-edit-title')
      assert.equal(await evaluate('document.querySelector("form").getAttribute("aria-describedby")'), 'user-edit-description')
      const tree = await send('Accessibility.getFullAXTree')
      assert.equal(tree.nodes.some(n => n.role?.value === 'textbox' && n.name?.value.includes('Nome completo')), true)
      assert.equal(tree.nodes.some(n => n.role?.value === 'textbox' && n.name?.value.includes('E-mail')), true)
      await input('#user-edit-name','Nome Atualizado')
      for (const width of [320,375,768,1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form button")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
        assert.equal(await evaluate(`!!document.querySelector('[role=region][tabindex="0"]')`), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
