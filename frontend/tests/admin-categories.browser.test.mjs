import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Transporte isolado: nenhuma requisição chega ao backend ou PostgreSQL.
function transport() {
  const params = new URLSearchParams(location.search)
  window.adminCategoryTest = {
    boot: crypto.randomUUID(), requests: [], aborts: 0,
    status: params.get('status') || '200', delay: Number(params.get('delay') || 30), ignoreAbort: params.has('ignoreAbort'),
    records: params.has('empty') ? [] : params.has('many') ? Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: i ? `Categoria ${i}` : 'NomeExtensoSemEspaços'.repeat(8), is_active: i % 2 === 0, tickets_count: i })) : [
      { id: 8, name: 'Software', is_active: false, tickets_count: 1200 }, { id: 2, name: 'Hardware', is_active: true, tickets_count: 0 },
    ],
  }
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname, state = window.adminCategoryTest
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, role: params.get('role') || 'admin', name: 'Usuário de teste', email: 'test@example.invalid' }, Number(params.get('userStatus') || 200))
    if (path === '/api/admin/categories') {
      state.requests.push({ method: options.method, credentials: options.credentials, body: options.body ?? null })
      const records = structuredClone(state.records), status = state.status
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, state.delay)
        options.signal?.addEventListener('abort', () => { state.aborts++; if (!state.ignoreAbort) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) } }, { once: true })
      })
      if (status === 'offline') throw TypeError('Offline')
      if (status === 'invalid') return json({ data: [{ id: 1 }] })
      return json({ data: records }, Number(status))
    }
    if (path === '/api/tickets') return json({ data: [], current_page: 1, last_page: 1, per_page: 15, total: 0, from: null, to: null, first_page_url: 'http://flowdesk.test/api/tickets?page=1', last_page_url: 'http://flowdesk.test/api/tickets?page=1', next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/tickets', links: [] })
    if (path.startsWith('/api/dashboard/')) {
      return json({ data: path.endsWith('/stats') ? { total: 0, open: 0, in_progress: 0, waiting_requester: 0, resolved: 0, closed: 0, cancelled: 0, unassigned: 0 } : path.endsWith('/sla') ? { on_track: 0, at_risk: 0, overdue: 0 } : [] })
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
  window.adminCategoryPanel = () => document.querySelector('section[aria-labelledby=categories-title]')
  window.adminCategoryRows = () => [...document.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent))
}

test('listagem administrativa de categorias no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (query = '', route = '#/categorias') => {
    const boot = await evaluate('window.adminCategoryTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?test=${crypto.randomUUID()}&${query}${route}` })
    const params = new URLSearchParams(query)
    const heading = params.has('userStatus') ? 'Entrar no Flowdesk'
      : ['technician', 'requester'].includes(params.get('role')) ? 'Acesso não permitido'
        : route === '#/chamados' ? 'Chamados' : 'Categorias'
    await wait(`window.adminCategoryTest?.boot !== ${JSON.stringify(boot)} && document.querySelector('h1')?.textContent===${JSON.stringify(heading)}`)
    if (params.has('userStatus')) await wait('!!document.querySelector("button[type=submit]") && !document.querySelector("button[type=submit]").disabled')
  }
  const ready = () => wait('adminCategoryPanel()?.getAttribute("aria-busy")==="false"')
  const navigate = async route => { await evaluate(`location.hash=${JSON.stringify(route)}`); await wait(`document.querySelector('h1')?.textContent===${JSON.stringify(route === '#/chamados' ? 'Chamados' : 'Categorias')}`) }
  try {
    await t.test('acesso direto, contrato, ordem, situação, contagem e ações sem botões fictícios', async () => {
      await load(); await ready()
      assert.equal(await evaluate('document.title'), 'Categorias | Flowdesk')
      assert.deepEqual(await evaluate('adminCategoryRows()'), [['Software', 'Inativa', '1.200', 'EditarAtivar'], ['Hardware', 'Ativa', '0', 'EditarDesativar']])
      assert.deepEqual(await evaluate('adminCategoryTest.requests'), [{ method: 'GET', credentials: 'include', body: null }])
      assert.equal(await evaluate('document.querySelector("nav a[aria-current=page]")?.getAttribute("href")'), '#/categorias')
      assert.equal(await evaluate('document.querySelectorAll("tbody button").length'), 4)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("tbody button")].map(b=>b.getAttribute("aria-label"))'), ['Editar categoria Software', 'Ativar categoria Software', 'Editar categoria Hardware', 'Desativar categoria Hardware'])
      assert.match(await evaluate('document.querySelector("main").textContent'), /Gerencie as categorias utilizadas nos chamados\./)
    })
    await t.test('carregamento sem dados fictícios e estado vazio', async () => {
      await load('delay=1500'); await wait('adminCategoryTest.requests.length===1')
      assert.match(await evaluate('adminCategoryPanel().textContent'), /Carregando categorias/)
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 0)
      await load('empty'); await ready()
      assert.match(await evaluate('adminCategoryPanel().textContent'), /Nenhuma categoria cadastrada\./)
    })
    for (const status of ['offline', 'invalid', '401', '403', '419', '500']) await t.test(`erro ${status}, mensagem e nova tentativa`, async () => {
      await load(`status=${status}`); await ready()
      assert.match(await evaluate('adminCategoryPanel().querySelector("[role=alert]").textContent'), ['401', '419'].includes(status) ? /sessão expirou/ : status === '403' ? /permissão/ : /Não foi possível carregar/)
      assert.deepEqual(await evaluate('adminCategoryRows()'), [])
      await evaluate('adminCategoryTest.status="200"; adminCategoryPanel().querySelector("button").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('adminCategoryTest.requests.length===2 && document.querySelectorAll("tbody tr").length===2')
    })
    for (const role of ['technician', 'requester']) await t.test(`${role}: sem item administrativo nem consulta por acesso direto`, async () => {
      await load(`role=${role}`)
      assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Acesso não permitido')
      assert.equal(await evaluate('document.querySelector("nav").textContent.includes("Categorias")'), false)
      assert.equal(await evaluate('adminCategoryTest.requests.length'), 0)
      assert.equal(await evaluate('document.querySelector("main a")?.getAttribute("href")'), '#/visao-geral')
    })
    for (const userStatus of [401, 403, 419]) await t.test(`sessão inicial ${userStatus}: autenticação preservada`, async () => {
      await load(`userStatus=${userStatus}`)
      assert.equal(await evaluate('!!document.querySelector("#workspace-navigation")'), false)
      assert.equal(await evaluate('adminCategoryTest.requests.length'), 0)
    })
    await t.test('sidebar pelo teclado e atualização ao retornar', async () => {
      await load('', '#/chamados')
      await evaluate("[...document.querySelectorAll('nav a')].find(a=>a.getAttribute('href')==='#/categorias').focus()")
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('document.querySelector("h1")?.textContent==="Categorias"'); await ready()
      await navigate('#/chamados')
      await evaluate('adminCategoryTest.records=[{id:4,name:"Rede atualizada",is_active:true,tickets_count:7}]')
      await navigate('#/categorias'); await ready()
      assert.deepEqual(await evaluate('adminCategoryRows()'), [['Rede atualizada', 'Ativa', '7', 'EditarDesativar']])
      assert.equal(await evaluate('adminCategoryTest.requests.length'), 2)
    })
    await t.test('cancelamento ao sair e resposta obsoleta ignorada', async () => {
      await load('delay=1500&ignoreAbort'); await wait('adminCategoryTest.requests.length===1')
      await navigate('#/chamados')
      assert.equal(await evaluate('adminCategoryTest.aborts'), 1)
      await evaluate('adminCategoryTest.delay=10;adminCategoryTest.records=[{id:4,name:"Resposta atual",is_active:true,tickets_count:5}]')
      await navigate('#/categorias'); await ready()
      await evaluate('new Promise(resolve=>setTimeout(resolve,1700))')
      assert.deepEqual(await evaluate('adminCategoryRows()'), [['Resposta atual', 'Ativa', '5', 'EditarDesativar']])
    })
    await t.test('nomes longos, muitas categorias, semântica e responsividade', async () => {
      await load('many'); await ready()
      assert.equal(await evaluate('adminCategoryRows().length'), 40)
      assert.equal(await evaluate('document.querySelectorAll("thead th[scope=col]").length'), 4)
      assert.equal(await evaluate('document.querySelectorAll("tbody th[scope=row]").length'), 40)
      assert.match(await evaluate('document.querySelector("caption").textContent'), /Categorias ativas e inativas/)
      for (const width of [320, 768, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('document.querySelector("[role=region]")?.tabIndex'), 0)
        assert.equal(await evaluate('getComputedStyle(document.querySelector("tbody th")).overflowWrap'), 'anywhere')
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
