import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Replaces every request before startup. No real API, login, or database is accessed.
function transport() {
  const params = new URLSearchParams(location.search)
  window.userStatusTest = { boot: crypto.randomUUID(), patches: [], gets: [], csrfGets: 0,
    patchStatus: 200, getStatus: 200, csrfStatus: 204, patchDelay: 100, getDelay: 10,
    conflictCode: 'status_changed',
    rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Conta ${String(i).padStart(2, '0')}`, email: `conta${i + 1}@example.invalid`,
      role: i === 0 || i === 4 ? 'admin' : i === 2 || i === 3 ? 'requester' : 'technician',
      disabled_at: i === 2 ? '2026-10-01T00:00:00Z' : null, created_at: '2026-10-27T12:00:00Z' })) }
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname, state = window.userStatusTest
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') {
      if (params.has('userDelay')) await new Promise(resolve => { state.releaseUser = resolve })
      state.userCompleted = true
      return json({ id: 1, name: 'Conta 00', email: 'conta1@example.invalid', role: params.get('role') || 'admin' })
    }
    if (path === '/api/revoke') return json({ code: 'session_revoked' }, 401)
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      if (state.csrfStatus !== 204) return json({ code: state.conflictCode }, state.csrfStatus)
      document.cookie = 'XSRF-TOKEN=user-status-test'
      return new Response(null, { status: 204 })
    }
    if (path === '/api/login' && options.method === 'POST') return json({ id: 1, name: 'Conta 00', email: 'conta1@example.invalid', role: 'admin' })
    const statusPath = path.match(/^\/api\/admin\/users\/(\d+)\/status$/)
    if (statusPath && options.method === 'PATCH') {
      const id = Number(statusPath[1]), payload = JSON.parse(options.body)
      state.patches.push({ id, payload, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN'), method: options.method })
      await new Promise(resolve => setTimeout(resolve, state.patchDelay))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus === 204) return new Response(null, { status: 204 })
      if (state.patchStatus === 'invalid') return json({ data: { id } })
      if (![200, 'offline_after_save'].includes(state.patchStatus)) return json({ code: state.conflictCode, errors: { is_active: ['private-marker'] }, message: 'private-marker SQL' }, state.patchStatus)
      const row = state.rows.find(row => row.id === id)
      if (!row) return json({}, 404)
      if (payload.expected_is_active !== (row.disabled_at === null)) return json({ code: 'status_changed' }, 409)
      row.disabled_at = payload.is_active ? null : '2026-10-29T12:00:00Z'
      if (state.patchStatus === 'offline_after_save') throw TypeError('Lost response')
      return json({ data: { ...row, session_version: 2, audit: 'private-marker' } })
    }
    if (path === '/api/admin/users' && options.method === 'GET') {
      const query = Object.fromEntries(parsed.searchParams)
      state.gets.push(query)
      await new Promise(resolve => setTimeout(resolve, state.getDelay))
      if (state.getStatus !== 200) return json({ code: state.conflictCode }, state.getStatus)
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

test('ativação e desativação no navegador', { skip: !browserExecutable, timeout: 180000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (role = 'admin') => {
    const boot = await evaluate('window.userStatusTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}#/usuarios` })
    await wait(`!!window.userStatusTest && window.userStatusTest.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
    await wait(role === 'admin' ? 'document.querySelectorAll("tbody tr").length===15' : 'document.querySelector("h1")?.textContent==="Acesso não permitido"')
  }
  const ready = () => wait('document.querySelector("section[aria-labelledby=users-title]")?.getAttribute("aria-busy")==="false"')
  const button = text => evaluate(`[...document.querySelectorAll('main button')].find(n=>n.textContent===${JSON.stringify(text)}).click()`)
  const input = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const open = async (name = 'Conta 01', action = 'Desativar') => {
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(`${action} usuário ${name}`)}]').click()`)
    await wait('!!document.querySelector("#user-status-panel") && document.activeElement?.textContent==="Cancelar"')
  }
  const confirm = () => evaluate('document.querySelector("#user-status-confirm").click()')
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const closed = () => wait('!document.querySelector("#user-status-panel")')
  const refresh = async () => { const count = await evaluate('userStatusTest.gets.length'); await button('Atualizar lista'); await wait(`userStatusTest.gets.length>${count}`); await ready() }
  const prepare = async () => { await open(); await confirm() }
  try {
    await t.test('abre com identificação, situação e consequências, sem misturar formulários', async () => {
      await load(); await open()
      assert.match(await evaluate('document.querySelector("#user-status-panel").textContent'), /Conta 01.*conta2@example.invalid.*Técnico.*Ativo/)
      assert.match(await evaluate('document.querySelector("#user-status-consequences").textContent'), /revoga as sessões.*preservados.*sem redistribuição.*resolvidos/)
      assert.equal(await evaluate('document.querySelectorAll("form input:not([type=checkbox]),form select").length'), 0)
      assert.equal(await evaluate('[...document.querySelectorAll("tbody button")].every(n=>n.disabled)'), true)
      assert.equal(await evaluate('[...document.querySelectorAll("main button")].find(n=>n.textContent==="Novo usuário").disabled'), true)
      await submit()
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true)
      assert.deepEqual(await evaluate('[userStatusTest.patches.length,userStatusTest.csrfGets]'), [0, 0])
    })
    await t.test('própria conta sem ação; ativos e desativados têm ações e indicadores distintos', async () => {
      await load()
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Desativar usuário Conta 00"]\')'), false)
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Ativar usuário Conta 00"]\')'), false)
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Ativar usuário Conta 02"]\')'), true)
      assert.equal(await evaluate('document.querySelectorAll("tbody tr")[2].children[3].textContent'), 'Desativado')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr")[1].children[3].textContent'), 'Ativo')
    })
    for (const escape of [false, true]) await t.test(`cancelar por ${escape ? 'Escape' : 'botão'} não grava e restaura foco`, async () => {
      await load(); await prepare()
      if (escape) await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      else await button('Cancelar')
      await closed()
      await wait('document.activeElement?.getAttribute("aria-label")==="Desativar usuário Conta 01"')
      assert.deepEqual(await evaluate('[userStatusTest.patches.length,userStatusTest.csrfGets]'), [0, 0])
    })
    for (const active of [true, false]) await t.test(`${active ? 'desativação' : 'ativação'} envia snapshot exato e atualiza listagem`, async () => {
      await load(); await open(active ? 'Conta 01' : 'Conta 02', active ? 'Desativar' : 'Ativar')
      if (!active) assert.match(await evaluate('document.querySelector("#user-status-consequences").textContent'), /sessões antigas permanecem revogadas.*entrar novamente/)
      await confirm(); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userStatusTest.patches'), [{ id: active ? 2 : 3, payload: { is_active: !active, expected_is_active: active }, credentials: 'include', csrf: 'user-status-test', method: 'PATCH' }])
      assert.match(await evaluate('document.querySelector("main").textContent'), active ? /Usuário desativado com sucesso/ : /Usuário ativado com sucesso/)
      assert.equal(await evaluate(`document.querySelectorAll('tbody tr')[${active ? 1 : 2}].children[3].textContent`), active ? 'Desativado' : 'Ativo')
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `${active ? 'Ativar' : 'Desativar'} usuário ${active ? 'Conta 01' : 'Conta 02'}`)
      assert.equal(await evaluate('document.querySelector("main").textContent.includes("private-marker")'), false)
      assert.equal(await evaluate('userStatusTest.gets.length'), 2)
    })
    await t.test('preserva pesquisa, perfil, situação e página quando usuário sai do filtro', async () => {
      await load()
      for (const [selector, value] of [['#user-search', 'Conta'], ['#user-role', 'technician'], ['#user-status', 'active']]) {
        const count = await evaluate('userStatusTest.gets.length'); await input(selector, value); await wait(`userStatusTest.gets.length>${count}`); await ready()
      }
      await button('Próxima'); await wait('userStatusTest.gets.at(-1).page==="2"'); await ready()
      const before = await evaluate('userStatusTest.gets.at(-1)')
      await open(await evaluate('document.querySelector("tbody th").textContent')); await confirm(); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userStatusTest.gets.at(-1)'), before)
      assert.deepEqual(await evaluate('[document.querySelector("#user-search").value,document.querySelector("#user-role").value,document.querySelector("#user-status").value]'), ['Conta', 'technician', 'active'])
      assert.equal(await evaluate('document.activeElement.id'), 'users-title')
    })
    await t.test('última página esvaziada usa a última válida sem perder filtro', async () => {
      await load(); await evaluate('userStatusTest.rows=userStatusTest.rows.filter(r=>r.role==="technician").slice(0,16)'); await refresh()
      await input('#user-status', 'active'); await wait('userStatusTest.gets.at(-1).status==="active"'); await ready()
      await button('Próxima'); await wait('document.querySelectorAll("tbody tr").length===1')
      await open(await evaluate('document.querySelector("tbody th").textContent')); await confirm(); await submit(); await closed()
      await wait('userStatusTest.gets.at(-1).page==="1" && document.querySelectorAll("tbody tr").length===15')
      assert.equal(await evaluate('document.querySelector("#user-status").value'), 'active')
      assert.equal(await evaluate('userStatusTest.patches.length'), 1)
    })
    await t.test('snapshot não muda com GET; conflito exige atualizar e confirmar novamente', async () => {
      await load(); await prepare(); await evaluate('userStatusTest.rows[1].disabled_at="2026-10-29T10:00:00Z"'); await refresh()
      assert.match(await evaluate('document.querySelector("#user-status-panel").textContent'), /Situação atual: Ativo/)
      await submit(); await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('userStatusTest.patches[0].payload.expected_is_active'), true)
      await submit(); assert.equal(await evaluate('userStatusTest.patches.length'), 1)
      await button('Atualizar dados'); await closed(); await ready(); await open('Conta 01', 'Ativar')
      assert.equal(await evaluate('document.querySelector("#user-status-confirm").checked'), false)
      await confirm(); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userStatusTest.patches[1].payload'), { is_active: true, expected_is_active: false })
    })
    for (const [code, message] of [['status_changed', /outra pessoa/], ['active_assignments', /chamados atribuídos/], ['last_active_admin', /administrador ativo/], ['session_version_exhausted', /renovar a autenticação/], ['private-marker', /conflito/]]) await t.test(`409 ${code}: motivo seguro e atualização obrigatória`, async () => {
      await load(); await prepare(); await evaluate(`userStatusTest.patchStatus=409;userStatusTest.conflictCode=${JSON.stringify(code)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && document.querySelector("form").getAttribute("aria-busy")==="false"')
      assert.match(await evaluate('document.querySelector("form").textContent'), message)
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'), false)
      assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'alert')
      await submit(); assert.equal(await evaluate('userStatusTest.patches.length'), 1)
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true)
      await button('Atualizar dados'); await closed(); await ready()
      assert.equal(await evaluate('userStatusTest.gets.length'), 2)
    })
    for (const status of [401, 403, 404, 419, 422, 503, 'offline', 'offline_after_save', 201, 204, 'invalid']) await t.test(`erro ${status}: não repete PATCH e permite consultar dados`, async () => {
      await load(); await prepare(); await evaluate(`userStatusTest.patchStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && document.querySelector("form").getAttribute("aria-busy")==="false"')
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'), false)
      assert.equal(await evaluate('document.querySelector("#user-status-confirm").checked'), false)
      assert.equal(await evaluate('!!document.querySelector("header")'), true)
      await submit(); assert.equal(await evaluate('userStatusTest.patches.length'), 1)
      await button('Atualizar dados'); await closed(); await ready()
      assert.equal(await evaluate('userStatusTest.patches.length'), 1)
      if (status === 'offline_after_save') {
        await open('Conta 01', 'Ativar')
        assert.equal(await evaluate('document.querySelector("#user-status-confirm").checked'), false)
      }
    })
    await t.test('processamento bloqueia duplicidade, cancelamento e Escape', async () => {
      await load(); await prepare(); await evaluate('userStatusTest.patchDelay=600')
      await evaluate('const f=document.querySelector("form");f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));')
      await wait('userStatusTest.patches.length===1')
      assert.equal(await evaluate('[...document.querySelectorAll("form input,form button")].every(n=>n.disabled)'), true)
      await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      assert.equal(await evaluate('!!document.querySelector("form")'), true)
      await closed(); await ready(); assert.equal(await evaluate('userStatusTest.patches.length'), 1)
    })
    for (const status of [419, 'offline']) await t.test(`CSRF ${status} impede PATCH`, async () => {
      await load(); await prepare(); await evaluate(`userStatusTest.csrfStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('userStatusTest.patches.length'), 0)
    })
    await t.test('sucesso seguido de falha da listagem permite recuperar somente com GET', async () => {
      await load(); await prepare(); await evaluate('userStatusTest.getStatus=503'); await submit(); await closed(); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Usuário desativado com sucesso/)
      assert.equal(await evaluate('document.activeElement.textContent'), 'Tentar novamente')
      await evaluate('userStatusTest.getStatus=200'); await button('Tentar novamente'); await ready()
      assert.equal(await evaluate('userStatusTest.patches.length'), 1)
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Ativar usuário Conta 01')
    })
    await t.test('401 session_revoked limpa identidade e conteúdo protegido; novo login funciona', async () => {
      await load(); await prepare(); await evaluate('userStatusTest.patchStatus=401;userStatusTest.conflictCode="session_revoked"'); await submit()
      await wait('!!document.querySelector("#email") && !document.querySelector("header")')
      assert.match(await evaluate('document.body.textContent'), /sessão foi revogada/)
      assert.equal(await evaluate('!!document.querySelector("tbody") || !!document.querySelector("#user-status-panel")'), false)
      assert.equal(await evaluate('document.body.textContent.includes("conta2@example.invalid")'), false)
      await input('#email', 'conta1@example.invalid'); await input('#password', 'password')
      await submit(); await wait('document.querySelectorAll("tbody tr").length===15')
      assert.equal(await evaluate('userStatusTest.patches.length'), 1)
    })
    await t.test('revogação recebida na consulta remove a página protegida', async () => {
      await load(); await evaluate('userStatusTest.getStatus=401;userStatusTest.conflictCode="session_revoked"'); await button('Atualizar lista')
      await wait('!!document.querySelector("#email") && !document.querySelector("header")')
      assert.equal(await evaluate('document.body.textContent.includes("Conta 01")'), false)
    })
    await t.test('resposta tardia da identidade não restaura sessão revogada', async () => {
      const boot = await evaluate('userStatusTest.boot')
      await send('Page.navigate', { url: `${browser.baseUrl}?userDelay=1&test=${crypto.randomUUID()}#/usuarios` })
      await wait(`!!window.userStatusTest && userStatusTest.boot!==${JSON.stringify(boot)} && typeof userStatusTest.releaseUser==="function"`)
      await evaluate('import("/src/services/api.ts").then(m=>m.apiRequest("/revoke")).catch(()=>{})')
      await wait('document.body.textContent.includes("sessão foi revogada")')
      await evaluate('userStatusTest.releaseUser()')
      await wait('userStatusTest.userCompleted===true')
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.equal(await evaluate('!!document.querySelector("header") || !!document.querySelector("tbody")'), false)
    })
    for (const role of ['requester', 'technician']) await t.test(`${role} não recebe ações administrativas`, async () => {
      await load(role)
      assert.deepEqual(await evaluate('[userStatusTest.gets.length,userStatusTest.patches.length]'), [0, 0])
    })
    await t.test('cadastro, edição e perfil continuam separados', async () => {
      for (const label of ['Novo usuário', 'Editar', 'Alterar perfil']) {
        await load(); await button(label); await wait('!!document.querySelector("form")')
        assert.equal(await evaluate('[...document.querySelectorAll("tbody button")].every(n=>n.disabled)'), true)
        assert.equal(await evaluate('!!document.querySelector("#user-status-panel")'), false)
      }
    })
    await t.test('teclado, árvore acessível e responsividade', async () => {
      await load(); await evaluate('document.querySelector(\'button[aria-label="Desativar usuário Conta 01"]\').focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('document.activeElement?.textContent==="Cancelar"')
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
      assert.equal(await evaluate('document.activeElement.id'), 'user-status-confirm')
      const tree = await send('Accessibility.getFullAXTree')
      assert.equal(tree.nodes.some(n => n.role?.value === 'checkbox' && n.name?.value.includes('Confirmo que desejo desativar')), true)
      for (const width of [320, 375, 768, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form button")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
