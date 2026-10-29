import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Toda a API é interceptada. Nenhum chamado é criado no backend ou banco reais.
function transport() {
  const role = new URLSearchParams(location.search).get('role') || 'requester'
  const user = { id: 1, role, name: 'Usuário de teste', email: 'teste@example.invalid' }
  window.creationTest = { boot: crypto.randomUUID(), posts: [], categoryGets: 0, listGets: 0, detailGets: 0, csrfGets: 0, postStatus: 201, getStatus: 200, categoryStatus: 200, csrfStatus: 204, responseId: 47, categories: [{ id: 4, name: 'Acesso' }, { id: 5, name: 'Hardware' }], categoryDelay: 40, blockNavigation: false, ticket: null }
  // Simula uma navegação que não chegou ao roteador, após o POST confirmado.
  window.addEventListener('hashchange', event => { if (window.creationTest.blockNavigation) event.stopImmediatePropagation() })
  window.fetch = async (url, options = {}) => {
    const state = window.creationTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json(user)
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      document.cookie = 'XSRF-TOKEN=creation-test'
      return state.csrfStatus === 204 ? new Response(null, { status: 204 }) : json({}, state.csrfStatus)
    }
    if (path === '/api/categories') {
      state.categoryGets++
      await new Promise(resolve => setTimeout(resolve, state.categoryDelay))
      if (state.categoryStatus === 'offline') throw TypeError('Offline')
      if (state.categoryStatus === 'invalid') return json({ data: null })
      return json({ data: state.categories }, state.categoryStatus)
    }
    if (path === '/api/tickets' && options.method === 'POST') {
      const input = JSON.parse(options.body)
      state.posts.push({ input, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, 150))
      if (state.postStatus === 'offline') throw TypeError('Offline')
      if (state.postStatus !== 201) return [204, 205].includes(state.postStatus) ? new Response(null, { status: state.postStatus }) : json({ errors: { title: ['Título inválido no teste.'], category_id: ['Categoria indisponível no teste.'] } }, state.postStatus)
      const date = '2026-10-22T10:00:00Z'
      state.ticket = {
        id: 47, title: input.title, description: input.description, priority: input.priority,
        requester: { id: user.id, name: user.name }, assignee: null,
        category: state.categories.find(category => category.id === input.category_id), status: { id: 1, code: 'open', name: 'Aberto' },
        created_at: date, updated_at: date, first_response_due_at: '2026-10-22T14:00:00Z', resolution_due_at: '2026-10-23T10:00:00Z',
        first_responded_at: null, resolved_at: null, closed_at: null, comments: [],
        activities: [{ id: 1, action: 'ticket_created', actor: { id: user.id, name: user.name }, created_at: date }],
      }
      return json({ ...state.ticket, id: state.responseId }, 201)
    }
    if (path === '/api/tickets') {
      state.listGets++
      const data = state.ticket ? [state.ticket] : []
      return json({ data, current_page: 1, last_page: 1, per_page: 15, total: data.length, from: data.length ? 1 : null, to: data.length ? 1 : null,
        first_page_url: 'http://flowdesk.test/api/tickets?page=1', last_page_url: 'http://flowdesk.test/api/tickets?page=1', next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/tickets', links: [] })
    }
    if (path === '/api/tickets/47') {
      state.detailGets++
      if (state.getStatus === 'offline') throw TypeError('Offline')
      return json(state.ticket, state.getStatus)
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('abertura de chamados no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (role = 'requester', route = '#/chamados/novo') => {
    const boot = await evaluate('window.creationTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}${route}` })
    await wait(`window.creationTest?.boot !== ${JSON.stringify(boot)} && document.querySelector('h1')?.textContent === ${JSON.stringify(route === '#/chamados' ? 'Chamados' : 'Novo chamado')}`)
  }
  const ready = () => wait('!!document.querySelector("#new-ticket-category") && !document.querySelector("#new-ticket-category").disabled')
  const text = (name, value) => evaluate(`(() => { const input = document.querySelector('form [name=${name}]'); Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  const select = (name, value) => evaluate(`(() => { const input=document.querySelector('select[name=${name}]'); input.value=${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const fill = async () => { await ready(); await text('title', '  Falha ao acessar  '); await text('description', '  Contexto do problema\n  '); await select('category_id', 4) }
  const created = () => wait('location.hash==="#/chamados/47" && document.querySelector("h1")?.textContent === "Falha ao acessar"')
  try {
    for (const role of ['requester', 'technician', 'admin']) await t.test(`${role}: listagem → Novo chamado → detalhes, mantendo navegação e layout`, async () => {
      await load(role, '#/chamados')
      await evaluate('[...document.querySelectorAll("a")].find(link=>link.textContent.trim()==="Novo chamado").click()')
      await wait('document.querySelector("h1")?.textContent === "Novo chamado"')
      await ready()
      assert.equal(await evaluate('document.querySelector("#new-ticket-priority").value'), 'medium')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("form [name]")].map(field=>field.name)'), ['title', 'description', 'category_id', 'priority'])
      assert.equal(await evaluate('document.querySelector("nav a[aria-current=page]").textContent.trim()'), 'Chamados')
      assert.equal(await evaluate('!!document.querySelector("header") && !!document.querySelector("aside")'), true)
      await fill()
      await submit()
      await created()
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=history-title] li p").textContent'), 'Chamado criado')
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=history-title] li").textContent.includes("ticket_created")'), false)
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=history-title] li > p").textContent'), 'Usuário de teste')
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=history-title] li time").getAttribute("datetime")'), '2026-10-22T10:00:00Z')
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      assert.equal(await evaluate('creationTest.detailGets'), 1)
      assert.deepEqual(await evaluate('creationTest.posts[0]'), { input: { title: 'Falha ao acessar', description: 'Contexto do problema', category_id: 4, priority: 'medium' }, credentials: 'include', csrf: 'creation-test' })
    })
    await t.test('categorias sob consulta, prioridade inicial Média e quatro opções em português', async () => {
      await load()
      await ready()
      assert.equal(await evaluate('creationTest.categoryGets'), 1)
      assert.deepEqual(await evaluate('[...document.querySelector("#new-ticket-category").options].filter(option=>option.value).map(option=>[option.value,option.textContent])'), [['4', 'Acesso'], ['5', 'Hardware']])
      assert.deepEqual(await evaluate('[...document.querySelector("#new-ticket-priority").options].map(option=>[option.value,option.textContent])'), [['low', 'Baixa'], ['medium', 'Média'], ['high', 'Alta'], ['urgent', 'Crítica']])
      assert.equal(await evaluate('document.activeElement.tagName'), 'H1')
    })
    await t.test('obrigatórios, texto vazio normalizado e foco no primeiro erro, sem POST', async () => {
      await load()
      await ready()
      await text('title', ' \t ')
      await text('description', '\n  ')
      await submit()
      await wait('!!document.querySelector("#title-error")')
      assert.equal(await evaluate('document.activeElement.id'), 'new-ticket-title')
      for (const name of ['title', 'description', 'category_id']) assert.equal(await evaluate(`!!document.querySelector('#${name}-error')`), true)
      assert.equal(await evaluate('creationTest.posts.length'), 0)
      assert.equal(await evaluate('creationTest.csrfGets'), 0)
    })
    await t.test('limites nativos e validação de título 256 e descrição 10.001 caracteres', async () => {
      await load()
      await fill()
      assert.equal(await evaluate('document.querySelector("#new-ticket-title").maxLength'), 255)
      assert.equal(await evaluate('document.querySelector("#new-ticket-description").maxLength'), 10000)
      await text('title', 'á'.repeat(256))
      await text('description', 'ç'.repeat(10001))
      await submit()
      await wait('!!document.querySelector("#title-error") && !!document.querySelector("#description-error")')
      assert.equal(await evaluate('creationTest.posts.length'), 0)
      await text('title', 'á'.repeat(255))
      await text('description', 'ç'.repeat(10000))
      assert.equal(await evaluate('document.querySelector("#title-count").textContent'), '255/255 caracteres')
      assert.equal(await evaluate('document.querySelector("#description-count").textContent'), '10.000 / 10.000 caracteres')
      await submit()
      await wait('location.hash==="#/chamados/47" && !!document.querySelector("main aside")')
      assert.equal(await evaluate('creationTest.posts[0].input.title.length'), 255)
      assert.equal(await evaluate('creationTest.posts[0].input.description.length'), 10000)
    })
    for (const priority of ['low', 'medium', 'high', 'urgent']) await t.test(`envia código de prioridade ${priority}`, async () => {
      await load()
      await fill()
      await select('priority', priority)
      await submit()
      await created()
      assert.equal(await evaluate('creationTest.posts[0].input.priority'), priority)
    })
    await t.test('Cancelar volta à listagem sem POST', async () => {
      await load()
      await fill()
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Cancelar").click()')
      await wait('location.hash==="#/chamados" && document.querySelector("h1")?.textContent==="Chamados"')
      assert.equal(await evaluate('creationTest.posts.length'), 0)
    })
    for (const status of [401, 403, 419, 503, 'offline', 'invalid', 'empty']) await t.test(`categorias ${status}: bloqueia envio, preserva dados e permite recarregar`, async () => {
      await load('requester', '#/chamados')
      await evaluate(status === 'empty' ? 'creationTest.categories=[]' : `creationTest.categoryStatus=${JSON.stringify(status)}`)
      await evaluate('[...document.querySelectorAll("a")].find(link=>link.textContent.trim()==="Novo chamado").click()')
      await wait('document.querySelector("h1")?.textContent==="Novo chamado" && document.querySelector("#categories-message").textContent.includes("Tentar novamente")')
      await text('title', 'Rascunho preservado')
      await text('description', 'Descrição preservada')
      await submit()
      assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true)
      assert.equal(await evaluate('creationTest.posts.length'), 0)
      await evaluate('creationTest.categoryStatus=200;creationTest.categories=[{id:4,name:"Acesso"}]')
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Tentar novamente").click()')
      await ready()
      assert.equal(await evaluate('document.querySelector("#new-ticket-title").value'), 'Rascunho preservado')
      assert.equal(await evaluate('document.querySelector("#new-ticket-description").value'), 'Descrição preservada')
      assert.equal(await evaluate('creationTest.categoryGets'), 2)
    })
    for (const status of [401, 403, 419, 422, 500, 503, 200, 202, 204, 205, 'offline']) await t.test(`POST ${status}: preserva dados, mostra erro e não navega nem repete automaticamente`, async () => {
      await load()
      await fill()
      await select('priority', 'urgent')
      await evaluate(`creationTest.postStatus=${JSON.stringify(status)}`)
      await submit()
      await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("button[type=submit]").disabled')
      assert.equal(await evaluate('document.querySelector("#new-ticket-title").value'), '  Falha ao acessar  ')
      assert.equal(await evaluate('document.querySelector("#new-ticket-description").value'), '  Contexto do problema\n  ')
      assert.equal(await evaluate('document.querySelector("#new-ticket-category").value'), '4')
      assert.equal(await evaluate('document.querySelector("#new-ticket-priority").value'), 'urgent')
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      assert.equal(await evaluate('creationTest.detailGets'), 0)
      assert.equal(await evaluate('location.hash'), '#/chamados/novo')
      if (status === 422) {
        await wait('document.activeElement.id==="new-ticket-title"')
        assert.equal(await evaluate('document.querySelector("#title-error").textContent'), 'Título inválido no teste.')
        assert.equal(await evaluate('document.querySelector("#category_id-error").textContent'), 'Categoria indisponível no teste.')
      }
    })
    await t.test('categoria desativada após a consulta: 422, nova lista e escolha preservada sem envio inválido', async () => {
      await load()
      await fill()
      await evaluate('creationTest.postStatus=422')
      await submit()
      await wait('!!document.querySelector("#category_id-error")')
      await evaluate('creationTest.categories=[{id:5,name:"Hardware"}]')
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Atualizar categorias").click()')
      await ready()
      await submit()
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      assert.equal(await evaluate('document.querySelector("#new-ticket-category").value'), '4')
      assert.equal(await evaluate('document.querySelector("#new-ticket-category").selectedOptions[0].disabled'), true)
      await select('category_id', 5)
      await evaluate('creationTest.postStatus=201')
      await submit()
      await created()
      assert.equal(await evaluate('creationTest.posts[1].input.category_id'), 5)
    })
    for (const status of [419, 'offline']) await t.test(`CSRF ${status}: não envia POST`, async () => {
      await load()
      await fill()
      await evaluate(`creationTest.csrfStatus=${JSON.stringify(status)}`)
      await submit()
      await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('creationTest.posts.length'), 0)
      assert.equal(await evaluate('document.querySelector("#new-ticket-title").value'), '  Falha ao acessar  ')
    })
    await t.test('dois submits síncronos geram um único POST e bloqueiam campos e cancelamento', async () => {
      await load()
      await fill()
      await evaluate('for(let i=0;i<2;i++)document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
      await wait('creationTest.posts.length===1')
      assert.equal(await evaluate('document.querySelector("fieldset").disabled'), true)
      assert.equal(await evaluate('[...document.querySelectorAll("form button")].every(button=>button.matches(":disabled"))'), true)
      await created()
      assert.equal(await evaluate('creationTest.posts.length'), 1)
    })
    for (const status of [503, 'offline']) await t.test(`GET posterior ${status}: tentar consultar novamente faz somente GET`, async () => {
      await load()
      await fill()
      await evaluate(`creationTest.getStatus=${JSON.stringify(status)}`)
      await submit()
      await wait('location.hash==="#/chamados/47" && [...document.querySelectorAll("button")].some(button=>button.textContent==="Tentar novamente")')
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Tentar novamente").click()')
      await wait('creationTest.detailGets===2 && !!document.querySelector("[role=alert]")')
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      await evaluate('creationTest.getStatus=200')
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Tentar novamente").click()')
      await created()
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      assert.equal(await evaluate('creationTest.detailGets'), 3)
    })
    await t.test('navegação não efetivada mantém confirmação, acesso aos detalhes e bloqueio de novo POST', async () => {
      await load()
      await fill()
      await evaluate('creationTest.blockNavigation=true')
      await submit()
      await wait('document.body.textContent.includes("Chamado #47 criado com sucesso.")')
      await submit()
      await submit()
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      assert.equal(await evaluate('document.querySelector("fieldset").disabled'), true)
      assert.equal(await evaluate('!!document.querySelector("button[type=submit]")'), false)
      assert.equal(await evaluate('[...document.querySelectorAll("form a")].some(link=>link.getAttribute("href")==="#/chamados/47")'), true)
    })
    for (const id of [null, '47', 0]) await t.test(`201 com ID ${JSON.stringify(id)}: confirma criação, orienta listagem e bloqueia novo POST`, async () => {
      await load()
      await fill()
      await evaluate(`creationTest.responseId=${JSON.stringify(id)}`)
      await submit()
      await wait('document.body.textContent.includes("A API não retornou") || document.body.textContent.includes("a API não retornou")')
      await submit()
      assert.equal(await evaluate('creationTest.posts.length'), 1)
      assert.equal(await evaluate('!!document.querySelector("button[type=submit]")'), false)
      assert.equal(await evaluate('creationTest.detailGets'), 0)
    })
    await t.test('acessibilidade, teclado, contadores e responsividade de 320 a 1440px', async () => {
      await load()
      await fill()
      const ax = await send('Accessibility.getFullAXTree')
      for (const [role, name] of [['textbox', 'Título'], ['textbox', 'Descrição'], ['combobox', 'Categoria'], ['combobox', 'Prioridade']]) assert.equal(ax.nodes.some(node=>node.role?.value===role && node.name?.value===name), true)
      await evaluate('document.querySelector("#new-ticket-title").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'new-ticket-description')
      for (const width of [1440, 1024, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form select,form textarea,form button")].every(element=>{const rect=element.getBoundingClientRect();return rect.width>0 && rect.left>=0 && rect.right<=innerWidth})'), true)
      }
      await evaluate('document.querySelector("button[type=submit]").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await created()
      await wait('document.activeElement.tagName==="H1"')
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
