import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Todas as chamadas são interceptadas; nenhum backend ou banco é utilizado.
function transport() {
  const params = new URLSearchParams(location.search)
  window.slaTest = {
    boot: crypto.randomUUID(), requests: [], aborts: 0, statsGets: 0, recentGets: 0,
    status: params.get('status') || '200', othersStatus: Number(params.get('othersStatus') || 200),
    delay: Number(params.get('delay') || 30), ignoreAbort: params.has('ignoreAbort'),
    counts: params.has('zero') ? { on_track: 0, at_risk: 0, overdue: 0 } : { on_track: 12, at_risk: 3, overdue: 7 },
  }
  window.fetch = async (url, options = {}) => {
    const state = window.slaTest, path = new URL(url).pathname
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
    if (path === '/api/dashboard/categories') return json({ data: [] })
    if (path === '/api/dashboard/sla') {
      state.requests.push({ method: options.method, credentials: options.credentials, accept: options.headers.get('Accept'), body: options.body ?? null })
      const counts = { ...state.counts }, status = state.status
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, state.delay)
        options.signal?.addEventListener('abort', () => {
          state.aborts++
          if (!state.ignoreAbort) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        }, { once: true })
      })
      if (status === 'offline') throw TypeError('Offline')
      if (status === 'invalid') return json({ data: { ...counts, at_risk: null } })
      if (status === 'json') return new Response('{')
      return json({ data: counts }, Number(status))
    }
    if (path === '/api/tickets') return json({ data: [], current_page: 1, last_page: 1, per_page: 15, total: 0, from: null, to: null, first_page_url: 'http://flowdesk.test/api/tickets?page=1', last_page_url: 'http://flowdesk.test/api/tickets?page=1', next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/tickets', links: [] })
    throw Error(`Requisição inesperada: ${path}`)
  }
  window.slaPanel = () => document.querySelector('section[aria-labelledby=dashboard-sla-title]')
  window.slaValues = () => [...slaPanel().querySelectorAll('dd')].map(node => node.textContent)
  window.metricValues = () => [...document.querySelectorAll('section[aria-label="Indicadores de atendimento"] article > p:first-of-type')].map(node => node.textContent)
}

test('prazos de atendimento no Dashboard', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (query = '') => {
    const boot = await evaluate('window.slaTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?test=${crypto.randomUUID()}&${query}#/visao-geral` })
    await wait(`window.slaTest?.boot !== ${JSON.stringify(boot)} && !!window.slaPanel?.() && slaTest.requests.length===1 && slaTest.statsGets===1 && slaTest.recentGets===1`)
  }
  const ready = () => wait('slaPanel()?.getAttribute("aria-busy")==="false"')
  const navigate = async page => {
    await evaluate(`document.querySelector('nav a[href="#/${page}"]').click()`)
    await wait(`document.querySelector('h1')?.textContent === ${JSON.stringify(page === 'chamados' ? 'Chamados' : 'Visão geral')}`)
  }
  try {
    for (const role of ['admin', 'technician', 'requester']) await t.test(`${role}: contagens recebidas, rótulos e uma consulta no Strict Mode`, async () => {
      await load(`role=${role}`)
      await ready()
      assert.deepEqual(await evaluate('slaValues()'), ['12', '3', '7'])
      assert.deepEqual(await evaluate('[...slaPanel().querySelectorAll("dt")].map(node=>node.textContent)'), ['Dentro do prazo', 'Em risco', 'Vencidos'])
      assert.deepEqual(await evaluate('slaTest.requests'), [{ method: 'GET', credentials: 'include', accept: 'application/json', body: null }])
      assert.equal(await evaluate('slaPanel().textContent.includes("em breve")'), false)
    })
    await t.test('carregamento acessível não inventa zeros e não bloqueia outras seções', async () => {
      await load('delay=1000')
      assert.equal(await evaluate('slaPanel().getAttribute("aria-busy")'), 'true')
      assert.equal(await evaluate('!!slaPanel().querySelector("[role=status]")'), true)
      assert.deepEqual(await evaluate('slaValues()'), [])
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=recent-tickets-title]").textContent.includes("Nenhum chamado encontrado.")'), true)
      await ready()
    })
    await t.test('zeros reais são exibidos', async () => {
      await load('zero=1')
      await ready()
      assert.deepEqual(await evaluate('slaValues()'), ['0', '0', '0'])
    })
    for (const status of [403, 404, 419, 422, 500, 503, 'offline', 'invalid', 'json']) await t.test(`erro ${status}, recuperação e independência`, async () => {
      await load(`status=${status}`)
      await ready()
      assert.deepEqual(await evaluate('slaValues()'), [])
      assert.match(await evaluate('slaPanel().querySelector("[role=alert]").textContent'), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=recent-tickets-title]").textContent.includes("Nenhum chamado encontrado.")'), true)
      await evaluate('slaTest.status="200"; slaTest.delay=100; const button=slaPanel().querySelector("button"); button.click(); button.click()')
      await ready()
      assert.deepEqual(await evaluate('slaValues()'), ['12', '3', '7'])
      assert.deepEqual(await evaluate('[slaTest.requests.length,slaTest.statsGets,slaTest.recentGets]'), [2, 1, 1])
    })
    await t.test('erros nas outras seções não impedem SLA e seus retries são independentes', async () => {
      await load('othersStatus=503')
      await ready()
      assert.deepEqual(await evaluate('slaValues()'), ['12', '3', '7'])
      assert.equal(await evaluate('document.querySelectorAll("main [role=alert]").length'), 2)
      await evaluate('slaTest.othersStatus=200; document.querySelectorAll("main [role=alert] button").forEach(button=>button.click())')
      await wait('document.querySelectorAll("main [role=alert]").length===0')
      assert.deepEqual(await evaluate('[slaTest.requests.length,slaTest.statsGets,slaTest.recentGets]'), [1, 2, 2])
    })
    await t.test('voltar ao Dashboard consulta novamente sem polling ou recarga da página', async () => {
      await load()
      await ready()
      const boot = await evaluate('slaTest.boot')
      await navigate('chamados')
      await evaluate('slaTest.counts={on_track:8,at_risk:2,overdue:1}')
      await navigate('visao-geral')
      await ready()
      assert.deepEqual(await evaluate('slaValues()'), ['8', '2', '1'])
      assert.equal(await evaluate('slaTest.boot'), boot)
      await navigate('visao-geral')
      await evaluate('new Promise(resolve=>setTimeout(resolve,200))')
      assert.equal(await evaluate('slaTest.requests.length'), 2)
    })
    await t.test('cancela consultas obsoletas e ignora respostas tardias', async () => {
      await load('delay=800&ignoreAbort=1')
      await navigate('chamados')
      await evaluate('slaTest.delay=0; slaTest.counts.on_track=43')
      await navigate('visao-geral')
      await ready()
      await evaluate('new Promise(resolve=>setTimeout(resolve,900))')
      assert.deepEqual(await evaluate('slaValues()'), ['43', '3', '7'])
      assert.ok(await evaluate('slaTest.aborts>=1'))
      assert.equal(await evaluate('slaTest.requests.length'), 2)
    })
    await t.test('teclado, semântica acessível, cores e responsividade', async () => {
      await load('status=503')
      await ready()
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await evaluate('slaPanel().querySelector("button").focus(); slaTest.status="200"')
      assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('!!slaPanel().querySelector("dl")')
      const tree = await send('Accessibility.getFullAXTree')
      for (const name of ['Prazos de atendimento', 'Dentro do prazo', 'Em risco', 'Vencidos']) assert.ok(tree.nodes.some(node=>node.name?.value===name))
      assert.deepEqual(await evaluate('[...slaPanel().querySelectorAll("dt span")].map(node=>node.className.split(" ").at(-1))'), ['bg-emerald-600', 'bg-amber-500', 'bg-red-600'])
      for (const width of [1440, 1280, 1024, 640, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...slaPanel().querySelectorAll("dt,dd")].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
