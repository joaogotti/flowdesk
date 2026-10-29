import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// All API calls are replaced before startup. These tests never access Laravel or PostgreSQL.
function transport() {
  const params = new URLSearchParams(location.search)
  window.userRoleTest = { boot: crypto.randomUUID(), patches: [], gets: [], csrfGets: 0,
    patchStatus: 200, getStatus: 200, csrfStatus: 204, patchDelay: 100, getDelay: 10,
    conflictCode: 'role_changed', errors: { role: ['private-marker'] },
    rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Conta ${String(i).padStart(2,'0')}`, email: `conta${i + 1}@example.invalid`,
      role: i === 0 || i === 4 ? 'admin' : i === 2 || i === 3 ? 'requester' : 'technician',
      disabled_at: i === 2 ? '2026-10-01T00:00:00Z' : null, created_at: '2026-10-27T12:00:00Z' })) }
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname, state = window.userRoleTest
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Conta 00', email: 'conta1@example.invalid', role: params.get('role') || 'admin' })
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      if (state.csrfStatus !== 204) return json({}, state.csrfStatus)
      document.cookie = 'XSRF-TOKEN=user-role-test'
      return new Response(null, { status: 204 })
    }
    const rolePath = path.match(/^\/api\/admin\/users\/(\d+)\/role$/)
    if (rolePath && options.method === 'PATCH') {
      const id = Number(rolePath[1]), payload = JSON.parse(options.body)
      state.patches.push({ id, payload, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN'), method: options.method })
      await new Promise(resolve => setTimeout(resolve, state.patchDelay))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus === 204) return new Response(null, { status: 204 })
      if (state.patchStatus === 'invalid') return json({ data: { id } })
      if (![200,'offline_after_save'].includes(state.patchStatus)) return json({ code: state.conflictCode, errors: state.errors, message: 'private-marker SQL audit' }, state.patchStatus)
      const row = state.rows.find(row => row.id === id)
      if (!row) return json({},404)
      if (row.disabled_at !== null) return json({ code: 'target_disabled' },409)
      if (payload.expected_role !== row.role) return json({ code: 'role_changed' },409)
      row.role = payload.role
      if (state.patchStatus === 'offline_after_save') throw TypeError('Lost response')
      return json({ data: { ...row, audit: 'private-marker' } })
    }
    if (path === '/api/admin/users' && options.method === 'GET') {
      const query = Object.fromEntries(parsed.searchParams)
      state.gets.push(query)
      await new Promise(resolve => setTimeout(resolve,state.getDelay))
      if (state.getStatus === 'offline') throw TypeError('Offline')
      if (state.getStatus !== 200) return json({},state.getStatus)
      let rows = state.rows.filter(row => (!query.search || `${row.name} ${row.email}`.toLowerCase().includes(query.search.toLowerCase())) && (!query.role || row.role === query.role) && (!query.status || (row.disabled_at === null) === (query.status === 'active')))
      rows = rows.toSorted((a,b) => a.name.localeCompare(b.name) || a.id - b.id)
      const total = rows.length, page = Number(query.page || 1), perPage = Number(query.per_page || 15), start = (page - 1) * perPage, last = Math.max(1,Math.ceil(total / perPage))
      rows = rows.slice(start,start + perPage)
      const link = p => `http://flowdesk.test/api/admin/users?page=${p}`
      return json({ data: rows, total, current_page: page, per_page: perPage, last_page: last, from: rows.length ? start + 1 : null, to: rows.length ? start + rows.length : null,
        first_page_url: link(1), last_page_url: link(last), next_page_url: page < last ? link(page + 1) : null, prev_page_url: page > 1 ? link(page - 1) : null, path: 'http://flowdesk.test/api/admin/users', links: [] })
    }
    throw Error(`Unexpected request: ${options.method} ${path}`)
  }
}

test('alteração de perfil no navegador', { skip: !browserExecutable, timeout: 180000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate,wait,send } = browser
  await send('Emulation.setFocusEmulationEnabled',{ enabled: true })
  const load = async (role = 'admin') => {
    const boot = await evaluate('window.userRoleTest?.boot')
    await send('Page.navigate',{ url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}#/usuarios` })
    await wait(`!!window.userRoleTest && window.userRoleTest.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
    if (role === 'admin') await wait('document.querySelectorAll("tbody tr").length===15')
    else await wait('document.querySelector("h1")?.textContent==="Acesso não permitido"')
  }
  const ready = () => wait('document.querySelector("section[aria-labelledby=users-title]")?.getAttribute("aria-busy")==="false"')
  const button = text => evaluate(`[...document.querySelectorAll('main button')].find(n=>n.textContent===${JSON.stringify(text)}).click()`)
  const input = (selector,value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const open = async (name = 'Conta 01') => {
    await evaluate(`[...document.querySelectorAll('tbody button')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(`Alterar perfil de ${name}`)}).click()`)
    await wait('document.activeElement?.id==="user-role-next"')
  }
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const confirm = () => evaluate('document.querySelector("#user-role-confirm").click()')
  const closed = () => wait('!document.querySelector("#user-role-panel")')
  const refreshList = async () => { const count = await evaluate('userRoleTest.gets.length'); await button('Atualizar lista'); await wait(`userRoleTest.gets.length>${count}`); await ready() }
  const prepare = async (to = 'admin') => { await open(); await input('#user-role-next',to); await confirm() }
  try {
    await t.test('abre separado, identifica usuário, perfil atual e consequências',async () => {
      await load(); await open()
      assert.match(await evaluate('document.querySelector("#user-role-description").textContent'),/Conta 01.*conta2@example.invalid/)
      assert.match(await evaluate('document.querySelector("#user-role-panel").textContent'),/Perfil atual: Técnico/)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#user-role-next option")].map(n=>[n.value,n.textContent])'),[['requester','Solicitante'],['technician','Técnico'],['admin','Administrador']])
      assert.equal(await evaluate('document.querySelector("#user-role-next").value'),'technician')
      assert.match(await evaluate('document.querySelector("#user-role-warning").textContent'),/abertos.*andamento.*aguardando solicitante.*resolvidos/)
      assert.match(await evaluate('document.querySelector("#user-role-consequences").textContent'),/permissões de acesso.*preservados.*Nenhum responsável/)
      assert.equal(await evaluate('document.querySelectorAll("form input[type=password],form input[name=name],form input[name=email],form select[name=status]").length'),0)
      assert.equal(await evaluate('[...document.querySelectorAll("tbody button")].every(n=>n.disabled)'),true)
      assert.equal(await evaluate('[...document.querySelectorAll("main button")].find(n=>n.textContent==="Novo usuário").disabled'),true)
    })
    await t.test('não há ação para o próprio administrador ou usuário desativado',async () => {
      await load()
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Alterar perfil de Conta 00"]\')'),false)
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Alterar perfil de Conta 02"]\')'),false)
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Editar usuário Conta 00"]\')'),true)
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Editar usuário Conta 02"]\')'),true)
      assert.equal(await evaluate('document.querySelectorAll("tbody button[aria-label^=Alterar]").length'),13)
      assert.deepEqual(await evaluate('[userRoleTest.patches.length,userRoleTest.csrfGets]'),[0,0])
    })
    for (const escape of [false,true]) await t.test(`cancelamento por ${escape ? 'Escape' : 'botão'} restaura foco sem PATCH`,async () => {
      await load(); await prepare()
      if (escape) {
        await send('Input.dispatchKeyEvent',{ type: 'keyDown',key: 'Escape',code: 'Escape',windowsVirtualKeyCode: 27 })
        await send('Input.dispatchKeyEvent',{ type: 'keyUp',key: 'Escape',code: 'Escape',windowsVirtualKeyCode: 27 })
      } else await button('Cancelar')
      await wait('!document.querySelector("form") && document.activeElement?.getAttribute("aria-label")==="Alterar perfil de Conta 01"')
      assert.deepEqual(await evaluate('[userRoleTest.patches.length,userRoleTest.csrfGets]'),[0,0])
      await open(); assert.equal(await evaluate('document.querySelector("#user-role-next").value'),'technician')
      assert.equal(await evaluate('document.querySelector("#user-role-confirm").checked'),false)
    })
    await t.test('seleção exige confirmação explícita; voltar ao perfil atual não envia',async () => {
      await load(); await open(); await submit()
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),true)
      await input('#user-role-next','admin'); await submit()
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),true)
      await confirm(); assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),false)
      await input('#user-role-next','requester'); assert.equal(await evaluate('document.querySelector("#user-role-confirm").checked'),false)
      await confirm(); await input('#user-role-next','technician'); await submit()
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),true)
      assert.deepEqual(await evaluate('[userRoleTest.patches.length,userRoleTest.csrfGets]'),[0,0])
    })
    for (const [from,to] of [['requester','technician'],['requester','admin'],['technician','requester'],['technician','admin'],['admin','requester'],['admin','technician']]) await t.test(`${from} -> ${to}: confirma, envia snapshot exato e atualiza tabela`,async () => {
      await load(); await evaluate(`userRoleTest.rows[1].role=${JSON.stringify(from)}`); await refreshList(); await prepare(to)
      const beforeGets = await evaluate('userRoleTest.gets.length')
      await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userRoleTest.patches'),[{ id: 2,payload: { role: to,expected_role: from },credentials: 'include',csrf: 'user-role-test',method: 'PATCH' }])
      assert.equal(await evaluate('userRoleTest.gets.length'),beforeGets + 1)
      assert.match(await evaluate('document.querySelector("main").textContent'),/Perfil alterado com sucesso/)
      assert.equal(await evaluate('document.querySelectorAll("tbody tr")[1].children[2].textContent'),{ requester: 'Solicitante',technician: 'Técnico',admin: 'Administrador' }[to])
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Alterar perfil de Conta 01')
      assert.equal(await evaluate('document.querySelector("main").textContent.includes("private-marker")'),false)
      assert.equal(await evaluate('document.querySelector("header [title]").getAttribute("title")'),'Conta 00')
    })
    await t.test('preserva pesquisa, perfil, situação e página quando o usuário sai do filtro',async () => {
      await load()
      for (const [selector,value] of [['#user-search','Conta'],['#user-role','technician'],['#user-status','active']]) {
        const count = await evaluate('userRoleTest.gets.length'); await input(selector,value); await wait(`userRoleTest.gets.length>${count}`); await ready()
      }
      await button('Próxima'); await wait('userRoleTest.gets.at(-1).page==="2"'); await ready()
      const before = await evaluate('userRoleTest.gets.at(-1)')
      const name = await evaluate('document.querySelector("tbody th").textContent')
      await open(name); await input('#user-role-next','requester'); await confirm(); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userRoleTest.gets.at(-1)'),before)
      assert.deepEqual(await evaluate('[document.querySelector("#user-search").value,document.querySelector("#user-role").value,document.querySelector("#user-status").value]'),['Conta','technician','active'])
      assert.equal(await evaluate('document.activeElement.id'),'users-title')
    })
    await t.test('página final esvaziada retorna à última válida preservando filtro',async () => {
      await load(); await evaluate('userRoleTest.rows=userRoleTest.rows.filter(r=>r.role==="technician").slice(0,16)'); await refreshList()
      await input('#user-role','technician'); await wait('userRoleTest.gets.at(-1).role==="technician"'); await ready()
      await button('Próxima'); await wait('document.querySelectorAll("tbody tr").length===1')
      const name = await evaluate('document.querySelector("tbody th").textContent')
      await open(name); await input('#user-role-next','admin'); await confirm(); await submit(); await closed()
      await wait('userRoleTest.gets.at(-1).page==="1" && document.querySelectorAll("tbody tr").length===15')
      assert.equal(await evaluate('document.querySelector("#user-role").value'),'technician')
      assert.equal(await evaluate('userRoleTest.patches.length'),1)
    })
    await t.test('snapshot não muda com GET; conflito exige atualizar, reabrir e confirmar novamente',async () => {
      await load(); await prepare('admin'); await evaluate('userRoleTest.rows[1].role="admin"'); await refreshList()
      assert.match(await evaluate('document.querySelector("#user-role-panel").textContent'),/Perfil atual: Técnico/)
      await submit(); await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("button[type=button]").disabled')
      assert.equal(await evaluate('userRoleTest.patches[0].payload.expected_role'),'technician')
      assert.match(await evaluate('document.querySelector("form").textContent'),/outra pessoa/)
      await submit(); assert.equal(await evaluate('userRoleTest.patches.length'),1)
      await button('Atualizar dados'); await closed(); await ready(); await open()
      assert.match(await evaluate('document.querySelector("#user-role-panel").textContent'),/Perfil atual: Administrador/)
      await input('#user-role-next','requester'); await confirm(); await submit(); await closed(); await ready()
      assert.deepEqual(await evaluate('userRoleTest.patches[1].payload'),{ role: 'requester',expected_role: 'admin' })
    })
    for (const [code,match] of [['role_changed',/outra pessoa/],['active_assignments',/chamados atribuídos/],['last_active_admin',/administrador ativo/],['target_disabled',/desativada/],['private-marker',/conflito/]]) await t.test(`409 ${code}: motivo seguro, foco no erro e bloqueio até atualizar`,async () => {
      await load(); await prepare(); await evaluate(`userRoleTest.patchStatus=409;userRoleTest.conflictCode=${JSON.stringify(code)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && document.querySelector("form").getAttribute("aria-busy")==="false"')
      assert.match(await evaluate('document.querySelector("form").textContent'),match)
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'),false)
      assert.equal(await evaluate('document.activeElement.getAttribute("role")'),'alert')
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),true)
      assert.equal(await evaluate('document.querySelector("#user-role-next").disabled'),true)
      await submit(); assert.equal(await evaluate('userRoleTest.patches.length'),1)
      assert.equal(await evaluate('userRoleTest.gets.length'),1)
      await button('Atualizar dados'); await closed(); await ready()
      assert.equal(await evaluate('userRoleTest.gets.length'),2)
      assert.equal(await evaluate('userRoleTest.patches.length'),1)
    })
    await t.test('atualização após desativação remove ação e restaura foco na edição permitida',async () => {
      await load(); await prepare(); await evaluate('userRoleTest.rows[1].disabled_at="2026-10-01T00:00:00Z"'); await submit()
      await wait('!!document.querySelector("form [role=alert]")'); await button('Atualizar dados'); await closed(); await ready()
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Alterar perfil de Conta 01"]\')'),false)
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Editar usuário Conta 01')
    })
    for (const status of [401,403,404,419,503,'offline',201,204,'invalid']) await t.test(`erro ${status}: mantém escolha e não repete PATCH`,async () => {
      await load(); await prepare(); await evaluate(`userRoleTest.patchStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && document.querySelector("form").getAttribute("aria-busy")==="false"')
      assert.match(await evaluate('document.querySelector("form").textContent'),[401,419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : /Não foi possível confirmar/)
      assert.equal(await evaluate('document.querySelector("#user-role-next").value'),'admin')
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),true)
      await submit(); await refreshList(); assert.equal(await evaluate('userRoleTest.patches.length'),1)
    })
    await t.test('422 associa perfil ao campo, filtra mensagens internas e exige nova confirmação',async () => {
      await load(); await prepare(); await evaluate('userRoleTest.patchStatus=422'); await submit()
      await wait('!!document.querySelector("#user-role-error")')
      assert.equal(await evaluate('document.activeElement.id'),'user-role-next')
      assert.equal(await evaluate('document.querySelector("#user-role-next").getAttribute("aria-describedby")'),'user-role-error')
      assert.equal(await evaluate('document.querySelector("#user-role-confirm").checked'),false)
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'),false)
      await input('#user-role-next','requester'); await confirm(); await evaluate('userRoleTest.patchStatus=200'); await submit(); await closed(); await ready()
      assert.equal(await evaluate('userRoleTest.patches.length'),2)
    })
    await t.test('perfil inválido injetado no seletor é rejeitado antes de qualquer chamada',async () => {
      await load(); await open()
      await evaluate('document.querySelector("#user-role-next").add(new Option("Inválido","owner"))')
      await input('#user-role-next','owner'); await confirm(); await submit()
      await wait('!!document.querySelector("#user-role-error")')
      assert.equal(await evaluate('document.activeElement.id'),'user-role-next')
      assert.deepEqual(await evaluate('[userRoleTest.patches.length,userRoleTest.csrfGets]'),[0,0])
    })
    await t.test('422 no perfil esperado exige atualizar os dados e não reflete detalhes internos',async () => {
      await load(); await prepare(); await evaluate('userRoleTest.patchStatus=422;userRoleTest.errors={expected_role:["private-marker"],payload:["private-marker"]}'); await submit()
      await wait('!!document.querySelector("form [role=alert]") && document.querySelector("form").getAttribute("aria-busy")==="false"')
      assert.equal(await evaluate('document.querySelector("#user-role-next").disabled'),true)
      assert.equal(await evaluate('document.querySelector("form").textContent.includes("private-marker")'),false)
      await submit(); assert.equal(await evaluate('userRoleTest.patches.length'),1)
      await button('Atualizar dados'); await closed(); await ready()
    })
    await t.test('resposta perdida após gravação simulada: consulta estado sem novo PATCH',async () => {
      await load(); await prepare(); await evaluate('userRoleTest.patchStatus="offline_after_save"'); await submit()
      await wait('!!document.querySelector("form [role=alert]")'); await button('Atualizar dados'); await closed(); await ready(); await open()
      assert.equal(await evaluate('document.querySelector("#user-role-next").value'),'admin')
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'),true)
      assert.equal(await evaluate('userRoleTest.patches.length'),1)
    })
    await t.test('envios duplicados e cancelamento bloqueados durante processamento',async () => {
      await load(); await prepare(); await evaluate('userRoleTest.patchDelay=600')
      await evaluate('const f=document.querySelector("form");f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));')
      await wait('userRoleTest.patches.length===1')
      assert.equal(await evaluate('[...document.querySelectorAll("form input,form select,form button")].every(n=>n.disabled)'),true)
      await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      assert.equal(await evaluate('!!document.querySelector("form")'),true)
      await closed(); await ready(); assert.equal(await evaluate('userRoleTest.patches.length'),1)
    })
    for (const status of [419,'offline']) await t.test(`CSRF ${status}: impede PATCH`,async () => {
      await load(); await prepare(); await evaluate(`userRoleTest.csrfStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('userRoleTest.patches.length'),0)
    })
    await t.test('sucesso seguido de falha GET preserva confirmação; retry faz somente GET',async () => {
      await load(); await prepare(); await evaluate('userRoleTest.getStatus=503'); await submit(); await closed(); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'),/Perfil alterado com sucesso/)
      assert.equal(await evaluate('document.activeElement.textContent'),'Tentar novamente')
      await evaluate('userRoleTest.getStatus=200'); await button('Tentar novamente'); await ready()
      assert.equal(await evaluate('userRoleTest.patches.length'),1)
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Alterar perfil de Conta 01')
    })
    await t.test('cadastro e edição continuam separados e impedem abrir alteração simultânea',async () => {
      await load(); await button('Novo usuário'); await wait('!!document.querySelector("#user-create-panel")')
      assert.equal(await evaluate('[...document.querySelectorAll("tbody button")].every(n=>n.disabled)'),true)
      await button('Cancelar'); await evaluate('document.querySelector(\'button[aria-label="Editar usuário Conta 01"]\').click()'); await wait('!!document.querySelector("#user-edit-panel")')
      assert.equal(await evaluate('[...document.querySelectorAll("tbody button")].every(n=>n.disabled)'),true)
      assert.equal(await evaluate('!!document.querySelector("#user-role-panel")'),false)
      assert.equal(await evaluate('userRoleTest.patches.length'),0)
    })
    for (const role of ['technician','requester']) await t.test(`${role}: sem acesso à ação`,async () => {
      await load(role)
      assert.deepEqual(await evaluate('[userRoleTest.gets.length,userRoleTest.patches.length]'),[0,0])
    })
    await t.test('teclado, semântica acessível e responsividade',async () => {
      await load(); await evaluate('document.querySelector(\'button[aria-label="Alterar perfil de Conta 01"]\').focus()')
      await send('Input.dispatchKeyEvent',{ type: 'keyDown',key: 'Enter',code: 'Enter',windowsVirtualKeyCode: 13,text: '\r' })
      await send('Input.dispatchKeyEvent',{ type: 'keyUp',key: 'Enter',code: 'Enter',windowsVirtualKeyCode: 13 }); await wait('document.activeElement?.id==="user-role-next"')
      await input('#user-role-next','admin')
      await send('Input.dispatchKeyEvent',{ type: 'keyDown',key: 'Tab',code: 'Tab',windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent',{ type: 'keyUp',key: 'Tab',code: 'Tab',windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'),'user-role-confirm')
      const tree = await send('Accessibility.getFullAXTree')
      assert.equal(tree.nodes.some(n=>n.role?.value==='combobox' && n.name?.value==='Novo perfil'),true)
      assert.equal(tree.nodes.some(n=>n.role?.value==='checkbox' && n.name?.value.includes('Confirmo a alteração')),true)
      assert.equal(await evaluate('document.querySelector("form").getAttribute("aria-describedby")'),'user-role-description user-role-consequences user-role-warning')
      for (const width of [320,375,768,1440]) {
        await send('Emulation.setDeviceMetricsOverride',{ width,height: 1000,deviceScaleFactor: 1,mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form select,form button")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'),true)
      }
    })
    assert.deepEqual(browser.errors,[])
  } finally { await browser.close() }
})
