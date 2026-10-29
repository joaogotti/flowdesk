import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Transporte isolado: nenhum backend ou banco recebe requisições.
function transport() {
  const params = new URLSearchParams(location.search)
  window.categoriesTest = {
    boot: crypto.randomUUID(), requests: [], statsGets: 0, recentGets: 0, slaGets: 0, aborts: 0,
    status: params.get('status') || '200', othersStatus: Number(params.get('othersStatus') || 200),
    delay: Number(params.get('delay') || 30), ignoreAbort: params.has('ignoreAbort'),
    records: params.has('empty') ? [] : params.has('many') ? Array.from({ length: 45 }, (_, i) => ({ id: 100 - i, name: i === 0 ? 'NomeExtensoSemEspaços'.repeat(10) : `Categoria extensa de atendimento ${i}`, count: i })) : [
      { id: 9, name: 'Rede', count: 3 }, { id: 2, name: 'Hardware', count: 1 }, { id: 4, name: 'Acesso', count: 0 },
    ],
  }
  if (params.has('zero')) categoriesTest.records.forEach(row => row.count = 0)
  window.fetch = async (url, options = {}) => {
    const state = window.categoriesTest, path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, role: params.get('role') || 'requester', name: 'Usuário de teste', email: 'test@example.invalid' })
    if (path === '/api/dashboard/stats') {
      state.statsGets++
      return json({ data: { total: 21, open: 4, in_progress: 5, waiting_requester: 3, resolved: 2, closed: 6, cancelled: 1, unassigned: 7 } }, state.othersStatus)
    }
    if (path === '/api/dashboard/recent-tickets') {
      state.recentGets++
      return json({ data: [] }, state.othersStatus)
    }
    if (path === '/api/dashboard/sla') {
      state.slaGets++
      return json({ data: { on_track: 12, at_risk: 3, overdue: 7 } }, state.othersStatus)
    }
    if (path === '/api/dashboard/categories') {
      state.requests.push({ path, method: options.method, credentials: options.credentials, accept: options.headers.get('Accept'), body: options.body ?? null })
      const records = structuredClone(state.records), status = state.status
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, state.delay)
        options.signal?.addEventListener('abort', () => {
          state.aborts++
          if (!state.ignoreAbort) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        }, { once: true })
      })
      if (status === 'offline') throw TypeError('Offline')
      if (status === 'invalid') return json({ data: [{ ...records[0], count: -1 }] })
      if (status === 'json') return new Response('{')
      return json({ data: records }, Number(status))
    }
    if (path === '/api/tickets') return json({ data: [], current_page: 1, last_page: 1, per_page: 15, total: 0, from: null, to: null, first_page_url: 'http://flowdesk.test/api/tickets?page=1', last_page_url: 'http://flowdesk.test/api/tickets?page=1', next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/tickets', links: [] })
    throw Error(`Requisição inesperada: ${path}`)
  }
  window.categoryPanel = () => document.querySelector('section[aria-labelledby=dashboard-categories-title]')
  window.categoryNames = () => [...categoryPanel().querySelectorAll('li > div:first-child > span:first-child')].map(node => node.textContent)
  window.categoryCounts = () => [...categoryPanel().querySelectorAll('.tabular-nums')].map(node => node.firstChild.textContent)
  window.barWidths = () => [...categoryPanel().querySelectorAll('li [aria-hidden=true] > span')].map(node => node.style.width)
  window.metricValues = () => [...document.querySelectorAll('section[aria-label="Indicadores de atendimento"] article > p:first-of-type')].map(node => node.textContent)
  window.slaValues = () => [...document.querySelectorAll('section[aria-labelledby=dashboard-sla-title] dd')].map(node => node.textContent)
  window.counters = () => [categoriesTest.requests.length, categoriesTest.statsGets, categoriesTest.recentGets, categoriesTest.slaGets]
}

test('organização da fila no Dashboard', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (query = '') => {
    const boot = await evaluate('window.categoriesTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?test=${crypto.randomUUID()}&${query}#/visao-geral` })
    await wait(`window.categoriesTest?.boot !== ${JSON.stringify(boot)} && !!window.categoryPanel?.() && categoriesTest.requests.length===1 && categoriesTest.statsGets===1 && categoriesTest.recentGets===1 && categoriesTest.slaGets===1`)
  }
  const ready = () => wait('categoryPanel()?.getAttribute("aria-busy")==="false"')
  const navigate = async page => {
    await evaluate(`document.querySelector('nav a[href="#/${page}"]').click()`)
    await wait(`document.querySelector('h1')?.textContent === ${JSON.stringify(page === 'chamados' ? 'Chamados' : 'Visão geral')}`)
  }
  try {
    for (const role of ['admin', 'technician', 'requester']) await t.test(`${role}: preserva ordem, nomes, contagens e sessão sem filtros ou duplicação no Strict Mode`, async () => {
      await load(`role=${role}`)
      await ready()
      assert.deepEqual(await evaluate('categoryNames()'), ['Rede', 'Hardware', 'Acesso'])
      assert.deepEqual(await evaluate('categoryCounts()'), ['3', '1', '0'])
      assert.deepEqual(await evaluate('barWidths()'), ['75%', '25%', '0%'])
      assert.deepEqual(await evaluate('categoriesTest.requests'), [{ path: '/api/dashboard/categories', method: 'GET', credentials: 'include', accept: 'application/json', body: null }])
      assert.equal(await evaluate('categoryPanel().textContent.includes("será exibida")'), false)
    })
    await t.test('carregamento sem lista ou zeros falsos não bloqueia outras seções', async () => {
      await load('delay=1000')
      assert.equal(await evaluate('categoryPanel().getAttribute("aria-busy")'), 'true')
      assert.match(await evaluate('categoryPanel().querySelector("[role=status]").textContent'), /Carregando categorias/)
      assert.deepEqual(await evaluate('categoryCounts()'), [])
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      await wait('slaValues().length===3')
      assert.deepEqual(await evaluate('slaValues()'), ['12', '3', '7'])
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=recent-tickets-title]").textContent.includes("Nenhum chamado encontrado.")'), true)
      await ready()
    })
    await t.test('zeros reais mantêm categorias com barras vazias, sem divisão por zero', async () => {
      await load('zero=1')
      await ready()
      assert.deepEqual(await evaluate('categoryCounts()'), ['0', '0', '0'])
      assert.deepEqual(await evaluate('barWidths()'), ['0%', '0%', '0%'])
      assert.deepEqual(await evaluate('categoryNames()'), ['Rede', 'Hardware', 'Acesso'])
      assert.equal(await evaluate('categoryPanel().textContent.includes("Nenhuma categoria cadastrada.")'), false)
    })
    await t.test('ausência de categorias é diferente de contagens zeradas', async () => {
      await load('empty=1')
      await ready()
      assert.equal(await evaluate('categoryPanel().querySelector("[role=status]").textContent'), 'Nenhuma categoria cadastrada.')
      assert.equal(await evaluate('!!categoryPanel().querySelector("ul")'), false)
    })
    for (const status of [401, 403, 404, 419, 422, 500, 503, 'offline', 'invalid', 'json']) await t.test(`erro ${status}: mensagem, retry local e preservação das outras três seções`, async () => {
      await load(`status=${status}`)
      await ready()
      assert.deepEqual(await evaluate('categoryCounts()'), [])
      assert.match(await evaluate('categoryPanel().querySelector("[role=alert]").textContent'), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      await wait('slaValues().length===3')
      assert.deepEqual(await evaluate('slaValues()'), ['12', '3', '7'])
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=recent-tickets-title]").textContent.includes("Nenhum chamado encontrado.")'), true)
      await evaluate('categoriesTest.status="200"; categoriesTest.delay=100; const button=categoryPanel().querySelector("button"); button.click(); button.click()')
      await ready()
      assert.deepEqual(await evaluate('categoryCounts()'), ['3', '1', '0'])
      assert.deepEqual(await evaluate('counters()'), [2, 1, 1, 1])
    })
    await t.test('erros das outras três seções não apagam categorias ou repetem sua consulta', async () => {
      await load('othersStatus=503')
      await ready()
      await wait('document.querySelectorAll("main [role=alert]").length===3')
      assert.deepEqual(await evaluate('categoryCounts()'), ['3', '1', '0'])
      await evaluate('categoriesTest.othersStatus=200; document.querySelectorAll("main [role=alert] button").forEach(button=>button.click())')
      await wait('document.querySelectorAll("main [role=alert]").length===0')
      assert.deepEqual(await evaluate('counters()'), [1, 2, 2, 2])
    })
    await t.test('retornar ao Dashboard consulta dados novos sem recarga e sem polling', async () => {
      await load()
      await ready()
      const boot = await evaluate('categoriesTest.boot')
      await navigate('chamados')
      await evaluate('categoriesTest.records=[{id:7,name:"Categoria nova",count:8}]')
      await navigate('visao-geral')
      await ready()
      assert.deepEqual(await evaluate('categoryNames()'), ['Categoria nova'])
      assert.deepEqual(await evaluate('categoryCounts()'), ['8'])
      assert.deepEqual(await evaluate('barWidths()'), ['100%'])
      assert.equal(await evaluate('categoriesTest.boot'), boot)
      await navigate('visao-geral')
      await evaluate('new Promise(resolve=>setTimeout(resolve,200))')
      assert.deepEqual(await evaluate('counters()'), [2, 2, 2, 2])
    })
    await t.test('aborta consulta ao sair e ignora resposta tardia mesmo se o transporte não cancelar', async () => {
      await load('delay=800&ignoreAbort=1')
      await navigate('chamados')
      await evaluate('categoriesTest.delay=0; categoriesTest.records[0].count=43')
      await navigate('visao-geral')
      await ready()
      await evaluate('new Promise(resolve=>setTimeout(resolve,900))')
      assert.deepEqual(await evaluate('categoryCounts()'), ['43', '1', '0'])
      assert.ok(await evaluate('categoriesTest.aborts>=1'))
      assert.equal(await evaluate('categoriesTest.requests.length'), 2)
    })
    await t.test('retry por teclado com foco visível e valores acessíveis sem depender de barras', async () => {
      await load('status=503')
      await ready()
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await evaluate('categoryPanel().querySelector("button").focus(); categoriesTest.status="200"')
      assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('categoryCounts().length===3')
      const tree = await send('Accessibility.getFullAXTree')
      assert.ok(tree.nodes.some(node=>node.role?.value==='heading' && node.name?.value==='Organização da fila'))
      assert.ok(tree.nodes.some(node=>node.role?.value==='list' && node.name?.value==='Chamados por categoria'))
      assert.ok(tree.nodes.some(node=>node.name?.value==='Rede'))
      assert.equal(await evaluate('[...categoryPanel().querySelectorAll("li [aria-hidden=true]")].length'), 3)
      assert.deepEqual(await evaluate('[...categoryPanel().querySelectorAll(".sr-only")].map(node=>node.textContent)'), [' chamados', ' chamado', ' chamados'])
    })
    await t.test('45 categorias, nomes longos e sem espaços não são truncados entre 320 e 1440px', async () => {
      await load('many=1')
      await ready()
      assert.equal(await evaluate('categoryCounts().length'), 45)
      assert.equal(await evaluate('categoryNames()[0]===categoriesTest.records[0].name'), true)
      for (const width of [1440, 1280, 1024, 640, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...categoryPanel().querySelectorAll("li,li > div:first-child > span")].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
        assert.equal(await evaluate('categoryPanel().scrollHeight<=categoryPanel().clientHeight'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
