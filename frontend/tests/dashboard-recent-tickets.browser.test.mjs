import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

function transport() {
  const params = new URLSearchParams(location.search)
  const status = params.get('status') || '200'
  const statuses = [['open', 'Aberto'], ['in_progress', 'Em andamento'], ['waiting_requester', 'Aguardando solicitante'], ['resolved', 'Resolvido'], ['closed', 'Fechado']]
  window.recentTest = {
    boot: crypto.randomUUID(), recentGets: 0, statsGets: 0, detailGets: 0, requests: [], aborts: 0,
    status: /^\d+$/.test(status) ? Number(status) : status, statsStatus: Number(params.get('statsStatus') || 200),
    delay: Number(params.get('delay') || 30), ignoreAbort: params.has('ignoreAbort'),
    records: params.has('empty') ? [] : statuses.map(([code, name], i) => ({ id: [9, 47, 20, 31, 12][i], title: ['Falha no acesso', 'Impressora da recepção', 'Acesso ao sistema', 'Rede da filial', 'Instalação de aplicativo'][i], status: { code, name }, assignee: i % 2 ? { id: 8, name: 'Técnico responsável' } : null, updated_at: '2026-10-23T01:30:00.000000Z' })),
  }
  window.fetch = async (url, options = {}) => {
    const state = window.recentTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Usuário de teste', email: 'test@example.invalid', role: params.get('role') || 'requester' })
    if (path === '/api/dashboard/sla') return json({ data: { on_track: 0, at_risk: 0, overdue: 0 } })
    if (path === '/api/dashboard/categories') return json({ data: [] })
    if (path === '/api/dashboard/stats') {
      state.statsGets++
      return json({ data: { total: 21, open: 4, in_progress: 5, waiting_requester: 3, resolved: 2, closed: 6, cancelled: 1, unassigned: 7 } }, state.statsStatus)
    }
    if (path === '/api/dashboard/recent-tickets') {
      state.recentGets++
      state.requests.push({ path, method: options.method, credentials: options.credentials, body: options.body ?? null })
      const rows = structuredClone(state.records), status = state.status
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
      return json({ data: rows }, status)
    }
    if (/^\/api\/tickets\/\d+$/.test(path)) {
      state.detailGets++
      const row = state.records.find(row => row.id === Number(path.split('/').at(-1)))
      return json({ ...row, status: { ...row.status, id: 1 }, requester: { id: 1, name: 'Usuário de teste' }, category: { id: 1, name: 'Acesso' }, priority: 'medium', description: 'Contexto do chamado', created_at: '2026-10-21T10:00:00Z', first_response_due_at: '2026-10-21T14:00:00Z', resolution_due_at: '2026-10-22T10:00:00Z', first_responded_at: null, resolved_at: null, closed_at: null, comments: [], activities: [] })
    }
    if (path === '/api/tickets') return json({ data: [], current_page: 1, last_page: 1, per_page: 15, total: 0, from: null, to: null, first_page_url: 'http://flowdesk.test/api/tickets?page=1', last_page_url: 'http://flowdesk.test/api/tickets?page=1', next_page_url: null, prev_page_url: null, path: 'http://flowdesk.test/api/tickets', links: [] })
    throw Error(`Requisição inesperada: ${path}`)
  }
  window.recentPanel = () => document.querySelector('section[aria-labelledby=recent-tickets-title]')
  window.metricValues = () => [...document.querySelectorAll('section[aria-label="Indicadores de atendimento"] article > p:first-of-type')].map(node => node.textContent)
}

test('chamados recentes no Dashboard', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (query = '') => {
    const boot = await evaluate('window.recentTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?test=${crypto.randomUUID()}&${query}#/visao-geral` })
    await wait(`window.recentTest?.boot !== ${JSON.stringify(boot)} && !!window.recentPanel?.() && recentTest.recentGets===1 && recentTest.statsGets===1`)
  }
  const ready = () => wait('recentPanel().getAttribute("aria-busy")==="false"')
  const retry = () => evaluate('recentPanel().querySelector("button").click()')
  const home = async () => {
    await evaluate(`document.querySelector('nav a[href="#/visao-geral"]').click()`)
    await wait('document.querySelector("h1")?.textContent === "Visão geral"')
    await ready()
  }
  try {
    for (const role of ['admin', 'technician', 'requester']) await t.test(`${role}: cinco chamados, campos reais, ordem recebida e uma consulta`, async () => {
      await load(`role=${role}`)
      await ready()
      assert.deepEqual(await evaluate('[...recentPanel().querySelectorAll("tbody th a")].map(link=>link.getAttribute("href"))'), ['#/chamados/9', '#/chamados/47', '#/chamados/20', '#/chamados/31', '#/chamados/12'])
      assert.equal(await evaluate('recentPanel().querySelector("tbody th").textContent'), '#9Falha no acesso')
      assert.equal(await evaluate('recentPanel().querySelector("tbody tr td").textContent'), 'StatusAberto')
      assert.equal(await evaluate('recentPanel().querySelector("tbody tr td:nth-of-type(2)").textContent'), 'ResponsávelNão atribuído')
      assert.equal(await evaluate('recentPanel().querySelectorAll("tbody tr")[1].textContent.includes("Técnico responsável")'), true)
      assert.equal(await evaluate('recentPanel().querySelector("time").dateTime'), '2026-10-23T01:30:00.000000Z')
      assert.match(await evaluate('recentPanel().querySelector("time").textContent'), /22\/10\/2026.*22:30/)
      assert.equal(await evaluate('recentPanel().textContent.includes("Em breve")'), false)
      assert.equal(await evaluate('!!document.querySelector(\'aside a[href="#/configuracoes"]\')'), true)
      assert.deepEqual(await evaluate('recentTest.requests'), [{ path: '/api/dashboard/recent-tickets', method: 'GET', credentials: 'include', body: null }])
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
    })
    await t.test('carregamento não mostra linhas nem estado vazio e não bloqueia indicadores', async () => {
      await load('delay=1000')
      assert.equal(await evaluate('recentPanel().getAttribute("aria-busy")'), 'true')
      assert.equal(await evaluate('!!recentPanel().querySelector("[role=status]")'), true)
      assert.equal(await evaluate('!!recentPanel().querySelector("tbody")'), false)
      assert.equal(await evaluate('recentPanel().textContent.includes("Nenhum chamado encontrado.")'), false)
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      await ready()
    })
    await t.test('lista vazia apresenta mensagem sem fabricar chamados', async () => {
      await load('empty=1')
      await ready()
      assert.equal(await evaluate('recentPanel().querySelector("[role=status]").textContent.trim()'), 'Nenhum chamado encontrado.')
      assert.equal(await evaluate('recentPanel().querySelectorAll("a").length'), 0)
    })
    for (const status of [403, 404, 419, 422, 500, 503, 'offline', 'invalid', 'json']) await t.test(`erro ${status} e nova tentativa independem dos indicadores`, async () => {
      await load(`status=${status}`)
      await ready()
      assert.match(await evaluate('recentPanel().querySelector("[role=alert]").textContent'), [401, 419].includes(status) ? /sessão expirou.*Entre novamente/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
      assert.equal(await evaluate('!!recentPanel().querySelector("table")'), false)
      assert.deepEqual(await evaluate('metricValues()'), ['21', '4', '5', '7'])
      await evaluate('recentTest.status=200; recentTest.delay=100; const button=recentPanel().querySelector("button"); button.click(); button.click()')
      await ready()
      assert.equal(await evaluate('recentPanel().querySelectorAll("tbody tr").length'), 5)
      assert.equal(await evaluate('recentTest.recentGets'), 2)
      assert.equal(await evaluate('recentTest.statsGets'), 1)
    })
    await t.test('erro dos indicadores não impede tabela e repetir tabela não repete indicadores', async () => {
      await load('statsStatus=503&status=503')
      await ready()
      assert.deepEqual(await evaluate('metricValues()'), ['—', '—', '—', '—'])
      await evaluate('recentTest.status=200')
      await retry()
      await ready()
      assert.equal(await evaluate('recentPanel().querySelectorAll("tbody tr").length'), 5)
      assert.deepEqual(await evaluate('metricValues()'), ['—', '—', '—', '—'])
      assert.equal(await evaluate('recentTest.statsGets'), 1)
      assert.equal(await evaluate('[...document.querySelectorAll("main [role=alert]")].some(node=>node.textContent.includes("indicadores"))'), true)
    })
    await t.test('link abre detalhes e retorno atualiza tabela e indicadores sem recarregar página', async () => {
      await load()
      await ready()
      const boot = await evaluate('recentTest.boot')
      await evaluate('recentPanel().querySelector("tbody a").click()')
      await wait('location.hash==="#/chamados/9" && document.querySelector("h1")?.textContent==="Falha no acesso"')
      assert.equal(await evaluate('recentTest.detailGets'), 1)
      await evaluate('recentTest.records[0].title="Título atualizado"')
      await home()
      assert.equal(await evaluate('recentPanel().querySelector("tbody a").textContent'), '#9Título atualizado')
      assert.equal(await evaluate('recentTest.recentGets'), 2)
      assert.equal(await evaluate('recentTest.statsGets'), 2)
      assert.equal(await evaluate('recentTest.boot'), boot)
      await home()
      await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
      assert.equal(await evaluate('recentTest.recentGets'), 2)
    })
    await t.test('cancelamento e respostas tardias não substituem a consulta atual', async () => {
      await load('delay=700&ignoreAbort=1')
      await evaluate(`document.querySelector('nav a[href="#/chamados"]').click()`)
      await wait('document.querySelector("h1")?.textContent==="Chamados"')
      await evaluate('recentTest.delay=0; recentTest.records[0].title="Resposta atual"')
      await home()
      await evaluate('new Promise(resolve=>setTimeout(resolve,800))')
      assert.equal(await evaluate('recentPanel().querySelector("tbody a").textContent'), '#9Resposta atual')
      assert.ok(await evaluate('recentTest.aborts>=1'))
      assert.equal(await evaluate('recentTest.recentGets'), 2)
    })
    await t.test('tabela, links acessíveis, teclado e conteúdo completo de 320 a 1440px', async () => {
      await load()
      await ready()
      const tree = await send('Accessibility.getFullAXTree')
      assert.ok(tree.nodes.some(node=>node.role?.value==='table' && node.name?.value==='Chamados recentes disponíveis para sua conta'))
      assert.ok(tree.nodes.some(node=>node.role?.value==='link' && node.name?.value==='Abrir chamado #9: Falha no acesso'))
      await evaluate('recentTest.records[0].title="Título muito longo ".repeat(20); recentTest.records[1].assignee.name="Responsável ".repeat(15)')
      await evaluate(`document.querySelector('nav a[href="#/chamados"]').click()`)
      await wait('document.querySelector("h1")?.textContent==="Chamados"')
      await home()
      for (const width of [1440, 1280, 1024, 640, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...recentPanel().querySelectorAll("tbody th,tbody td")].every(node=>{const r=node.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth})'), true)
        assert.equal(await evaluate('getComputedStyle(recentPanel().querySelector("tbody th")).textOverflow'), 'clip')
      }
      await evaluate('recentPanel().querySelector("tbody a").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.getAttribute("href")'), '#/chamados/47')
      assert.notEqual(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'none')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('location.hash==="#/chamados/47" && document.querySelector("h1")?.textContent==="Impressora da recepção"')
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
