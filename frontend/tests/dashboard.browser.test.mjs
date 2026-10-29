import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// A API inteira é interceptada; nenhum backend ou banco recebe requisições.
function transport() {
  const params = new URLSearchParams(location.search)
  const initialStatus = params.get('status') || '200'
  window.dashboardTest = {
    boot: crypto.randomUUID(), requests: [], aborts: 0, delay: Number(params.get('delay') || 30),
    status: /^\d+$/.test(initialStatus) ? Number(initialStatus) : initialStatus,
    ignoreAbort: params.has('ignoreAbort'),
    counts: { total: 21, open: 4, in_progress: 5, waiting_requester: 3, resolved: 2, closed: 6, cancelled: 1, unassigned: 7 },
  }
  window.fetch = async (url, options = {}) => {
    const state = window.dashboardTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 8, role: params.get('role') || 'admin', name: 'Usuário de teste', email: 'test@example.invalid' })
    if (path === '/api/dashboard/recent-tickets') return json({ data: [] })
    if (path === '/api/dashboard/categories') return json({ data: [] })
    if (path === '/api/dashboard/sla') return json({ data: { on_track: 0, at_risk: 0, overdue: 0 } })
    if (path === '/api/dashboard/stats') {
      const counts = { ...state.counts }, status = state.status
      state.requests.push({ path, method: options.method, credentials: options.credentials, accept: options.headers.get('Accept'), body: options.body ?? null })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, state.delay)
        options.signal?.addEventListener('abort', () => {
          state.aborts++
          if (!state.ignoreAbort) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        }, { once: true })
      })
      if (status === 'offline') throw TypeError('Offline')
      if (status === 'invalid') return json({ data: null })
      if (status === 'json') return new Response('{')
      return json({ data: counts }, status)
    }
    if (path === '/api/tickets') return json({ data: [], current_page: 1, last_page: 1, per_page: 15, total: 0, from: null, to: null, first_page_url: 'http://flowdesk.test/api/tickets?page=1', last_page_url: 'http://flowdesk.test/api/tickets?page=1', next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/tickets', links: [] })
    throw Error(`Requisição inesperada: ${path}`)
  }
  window.metrics = () => document.querySelector('section[aria-label="Indicadores de atendimento"]')
  window.metricValues = () => [...metrics().querySelectorAll('article > p:first-of-type')].map(node => node.textContent)
}

test('indicadores do dashboard no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (query = '') => {
    const boot = await evaluate('window.dashboardTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?test=${crypto.randomUUID()}&${query}#/visao-geral` })
    await wait(`window.dashboardTest?.boot !== ${JSON.stringify(boot)} && !!window.metrics?.() && dashboardTest.requests.length === 1`)
  }
  const ready = () => wait('metrics()?.getAttribute("aria-busy") === "false"')
  const retry = () => evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "Tentar novamente").click()')
  const navigate = async page => {
    await evaluate(`document.querySelector('nav a[href="#/${page}"]').click()`)
    await wait(`document.querySelector('h1')?.textContent === ${JSON.stringify(page === 'chamados' ? 'Chamados' : 'Visão geral')}`)
  }
  try {
    for (const role of ['admin', 'technician', 'requester']) await t.test(`${role}: quatro cards reais, sem filtros locais ou duplicação no Strict Mode`, async () => {
      await load(`role=${role}`)
      await ready()
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      assert.deepEqual(await evaluate('[...metrics().querySelectorAll("h2")].map(node=>node.textContent)'), ['Total de chamados', 'Abertos', 'Em andamento', 'Sem responsável'])
      assert.deepEqual(await evaluate('dashboardTest.requests'), [{ path: '/api/dashboard/stats', method: 'GET', credentials: 'include', accept: 'application/json', body: null }])
      assert.equal(await evaluate('document.body.textContent.includes("SLA em risco") || document.body.textContent.includes("Dados em breve")'), false)
      assert.equal(await evaluate('!!document.querySelector("header") && !!document.querySelector("aside")'), true)
    })
    await t.test('carregamento acessível com traços e nenhum zero falso', async () => {
      await load('delay=1000')
      assert.equal(await evaluate('metrics().getAttribute("aria-busy")'), 'true')
      assert.deepEqual(await evaluate('metricValues()'), ['—', '—', '—', '—'])
      assert.equal(await evaluate('[...metrics().querySelectorAll("[aria-label]")].filter(node=>node.getAttribute("aria-label")==="Carregando indicador").length'), 4)
      assert.equal(await evaluate('document.querySelector("main [role=status]").textContent.includes("Carregando indicadores")'), true)
      await ready()
    })
    await t.test('zero real apresenta estado vazio e os quatro zeros', async () => {
      await load('status=503')
      await ready()
      await evaluate('dashboardTest.status=200; Object.keys(dashboardTest.counts).forEach(key=>dashboardTest.counts[key]=0)')
      await retry()
      await ready()
      assert.deepEqual(await evaluate('metricValues()'), ['0', '0', '0', '0'])
      assert.equal(await evaluate('document.querySelector("main [role=status]").textContent.includes("Nenhum chamado disponível para sua conta.")'), true)
    })
    for (const status of [401, 403, 404, 419, 422, 500, 503, 'offline', 'invalid', 'json']) await t.test(`erro ${status}: mensagem, sem números fictícios e nova consulta`, async () => {
      await load(`status=${status}`)
      await ready()
      assert.deepEqual(await evaluate('metricValues()'), ['—', '—', '—', '—'])
      assert.equal(await evaluate('!!document.querySelector("main [role=alert]")'), true)
      const message = await evaluate('document.querySelector("main [role=alert]").textContent')
      assert.match(message, [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
      await evaluate('dashboardTest.status=200; dashboardTest.delay=100')
      await retry()
      await wait('metrics().getAttribute("aria-busy") === "true"')
      assert.equal(await evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent==="Tentar novamente")'), false)
      await ready()
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      assert.equal(await evaluate('dashboardTest.requests.length'), 2)
      assert.equal(await evaluate('!!document.querySelector("main [role=alert]")'), false)
    })
    await t.test('retorno pela navegação consulta números novos, sem recarregar a página', async () => {
      await load()
      await ready()
      const boot = await evaluate('dashboardTest.boot')
      await navigate('chamados')
      await evaluate('dashboardTest.counts={total:8,open:2,in_progress:1,waiting_requester:2,resolved:1,closed:1,cancelled:1,unassigned:3}')
      await navigate('visao-geral')
      await ready()
      assert.deepEqual(await evaluate('metricValues()'), ['8', '2', '1', '3'])
      assert.equal(await evaluate('dashboardTest.boot'), boot)
      assert.equal(await evaluate('dashboardTest.requests.length'), 2)
      await navigate('visao-geral')
      await evaluate('new Promise(resolve=>setTimeout(resolve,200))')
      assert.equal(await evaluate('dashboardTest.requests.length'), 2)
    })
    await t.test('consulta obsoleta é cancelada e resposta tardia não substitui os números atuais', async () => {
      await load('delay=800&ignoreAbort=1')
      await navigate('chamados')
      await evaluate('dashboardTest.delay=0; dashboardTest.counts.total=43')
      await navigate('visao-geral')
      await ready()
      assert.equal(await evaluate('metricValues()[0]'), '43')
      await evaluate('new Promise(resolve=>setTimeout(resolve,900))')
      assert.equal(await evaluate('metricValues()[0]'), '43')
      assert.ok(await evaluate('dashboardTest.aborts >= 1'))
      assert.equal(await evaluate('dashboardTest.requests.length'), 2)
    })
    await t.test('teclado, acessibilidade e responsividade de 320 a 1440px', async () => {
      await load('status=503')
      await ready()
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Tentar novamente").focus(); dashboardTest.status=200')
      const errorTree = await send('Accessibility.getFullAXTree')
      assert.ok(errorTree.nodes.some(node=>node.role?.value==='button' && node.name?.value==='Tentar novamente'))
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('metrics().getAttribute("aria-busy")==="false" && !document.querySelector("main [role=alert]")')
      const tree = await send('Accessibility.getFullAXTree')
      for (const name of ['Total de chamados', 'Abertos', 'Em andamento', 'Sem responsável']) assert.ok(tree.nodes.some(node=>node.role?.value==='heading' && node.name?.value===name))
      for (const width of [1440, 1024, 640, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
        assert.equal(await evaluate('[...metrics().querySelectorAll("article")].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
