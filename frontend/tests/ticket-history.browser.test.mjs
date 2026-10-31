import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// API isolada exclusivamente no teste: não consulta ou altera chamados reais.
function transport() {
  const params = new URLSearchParams(location.search), role = params.get('role') || 'admin'
  const date = '2026-10-22T10:00:00Z', actor = { id: 1, name: 'Autor de teste' }
  const ref = { id: 8, name: 'Técnico de teste' }
  const event = (id, action, details) => ({ id, action, actor, created_at: new Date(Date.parse(date) + id * 60000).toISOString(), ...(details === undefined ? {} : { details }) })
  let activities = [
    event(2, 'created'), event(3, 'comment_added'),
    event(4, 'assignment_changed', { assignee: { from: null, to: ref } }),
    event(5, 'assignment_changed', { assignee: { from: ref, to: null } }),
    event(6, 'assignment_changed', { assignee: { from: null, to: ref } }),
    event(7, 'status_changed', { status: { from: 'open', to: 'in_progress' } }),
    event(8, 'details_changed', { category: { from: { id: 3, name: 'Rede' }, to: { id: 1, name: 'Hardware' } } }),
    event(9, 'details_changed', { priority: { from: 'medium', to: 'high' } }),
  ]
  const variant = params.get('variant')
  if (variant === 'legacy') activities = ['created', 'ticket_created', 'comment_added', 'assignment_changed', 'status_changed', 'details_changed', 'future_action'].map((action, i) => event(i + 1, action))
  if (variant === 'partial') activities = [
    event(1, 'assignment_changed', { assignee: { to: null } }),
    event(2, 'assignment_changed', { assignee: { from: { id: 99, name: null }, to: { id: 8, name: '' } } }),
    event(3, 'details_changed', { category: { from: { id: 99, name: null } }, priority: { from: null, to: 'urgent' } }),
    event(4, 'status_changed', { status: { from: 'invalid-private-marker', to: 'resolved' } }),
    event(5, 'details_changed', { category: { from: { id: 3, name: 'Rede' }, to: { id: 1, name: 'Hardware' } }, priority: { from: 'low', to: 'high' } }),
  ]
  if (variant === 'invalid') activities = [
    event(1, 'assignment_changed', { assignee: { from: false, to: { id: '8', name: 'private-marker' } } }),
    event(2, 'status_changed', { status: { from: 'private-marker', to: 'constructor' } }),
    event(3, 'details_changed', { priority: [] }),
    event(4, 'comment_added', { body: 'private-marker', priority: { from: 'low', to: 'urgent' } }),
  ].map(row => ({ ...row, changes: { body: 'private-marker' } }))
  if (variant === 'long') activities = [event(1, 'assignment_changed', { assignee: {
    from: { id: 8, name: 'NomeSemEspacos'.repeat(35) }, to: { id: 9, name: '<img src=x onerror=alert(1)>' },
  } })]
  if (variant === 'long') activities[0].actor = { id: 1, name: 'AutorSemEspacos'.repeat(30) }
  if (variant === 'empty') activities = []
  if (role === 'requester') activities = activities.filter(row => row.action === 'created')
  const ticket = {
    id: 8, title: 'Histórico de teste', description: 'Descrição de teste', priority: 'medium',
    requester: { id: 2, name: 'Solicitante de teste' }, assignee: ref, category: { id: 1, name: 'Hardware' },
    status: { id: 2, code: 'in_progress', name: 'Em andamento' }, created_at: date, updated_at: date,
    first_response_due_at: '2026-10-22T14:00:00Z', resolution_due_at: '2026-10-23T10:00:00Z',
    first_responded_at: null, resolved_at: null, closed_at: null, activities,
    comments: role === 'requester' ? [] : [{ id: 1, author: actor, body: 'Comentário interno restrito', is_internal: true, created_at: date }],
  }
  window.historyTest = { boot: crypto.randomUUID(), requests: [], ticket, status: Number(params.get('httpStatus') || 200) }
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname, state = window.historyTest
    state.requests.push({ path, method: options.method })
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: role === 'admin' ? 1 : role === 'technician' ? 8 : 2, role, name: 'Usuário de teste', email: 'test@example.invalid' })
    if (path === '/api/tickets/8' && options.method === 'GET') return json(ticket, state.status)
    throw Error(`Requisição inesperada: ${options.method} ${path}`)
  }
}

test('histórico detalhado no navegador', { skip: !browserExecutable, timeout: 90000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const load = async (role = 'admin', variant = 'normal', httpStatus = 200) => {
    const boot = await evaluate('window.historyTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&variant=${variant}&httpStatus=${httpStatus}&test=${crypto.randomUUID()}#/chamados/8` })
    await wait(`!!window.historyTest && window.historyTest.boot !== ${JSON.stringify(boot)}`)
    await wait(httpStatus === 200 ? '!!document.querySelector("#history-title")' : '!!document.querySelector("main [role=alert]")')
  }
  const lines = () => evaluate('[...document.querySelectorAll("section[aria-labelledby=history-title] li")].map(li=>[...li.children].filter(n=>n.tagName==="DIV").map(entry=>{const title=entry.querySelector(".font-medium").textContent;const detail=entry.querySelector(":scope > p");return title+(detail?" — "+detail.textContent:"")}))')
  try {
    for (const role of ['admin', 'technician']) await t.test(`${role}: oito eventos, transições, autor e datas preservados`, async () => {
      await load(role)
      assert.deepEqual(await lines(), [
        ['Chamado criado'], ['Comentário adicionado'],
        ['Responsável alterado — Não atribuído → Técnico de teste'],
        ['Responsável alterado — Técnico de teste → Não atribuído'],
        ['Responsável alterado — Não atribuído → Técnico de teste'],
        ['Status alterado — Aberto → Em andamento'],
        ['Categoria alterada — Rede → Hardware'], ['Prioridade alterada — Média → Alta'],
      ])
      assert.equal(await evaluate('[...document.querySelectorAll("section[aria-labelledby=history-title] li")].every(li=>li.lastElementChild.textContent==="Autor de teste")'), true)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("section[aria-labelledby=history-title] time")].map(n=>n.dateTime)'), await evaluate('historyTest.ticket.activities.map(a=>a.created_at)'))
      assert.match(await evaluate('document.querySelector("article").textContent'), /Interno/)
    })
    await t.test('eventos antigos e ações desconhecidas mantêm descrições genéricas', async () => {
      await load('admin', 'legacy')
      assert.deepEqual(await lines(), [['Chamado criado'], ['Chamado criado'], ['Comentário adicionado'], ['Responsável alterado'], ['Status alterado'], ['Informações alteradas'], ['future_action']])
    })
    await t.test('referências indisponíveis, lados ausentes e alterações conjuntas', async () => {
      await load('admin', 'partial')
      assert.deepEqual(await lines(), [
        ['Responsável alterado — Não informado → Não atribuído'], ['Responsável alterado — Usuário #99 → Usuário #8'],
        ['Categoria alterada — Categoria #99 → Não informado', 'Prioridade alterada — Não informado → Crítica'],
        ['Status alterado — Não informado → Resolvido'], ['Categoria alterada — Rede → Hardware', 'Prioridade alterada — Baixa → Alta'],
      ])
      assert.equal(await evaluate('document.querySelector("main").textContent.includes("invalid-private-marker")'), false)
    })
    await t.test('dados inválidos e metadados de comentários nunca são exibidos no histórico', async () => {
      await load('admin', 'invalid')
      assert.deepEqual(await lines(), [['Responsável alterado'], ['Status alterado'], ['Informações alteradas'], ['Comentário adicionado']])
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=history-title]").textContent.includes("private-marker")'), false)
    })
    await t.test('solicitante recebe somente o histórico público fornecido pela API', async () => {
      await load('requester')
      assert.deepEqual(await lines(), [['Chamado criado']])
      assert.equal(await evaluate('document.querySelectorAll("article").length'), 0)
      assert.equal(await evaluate('document.querySelector("main").textContent.includes("Comentário interno restrito")'), false)
      assert.equal(await evaluate('!!document.querySelector("input[name=is_internal]")'), false)
    })
    for (const status of [403, 404, 419]) await t.test(`HTTP ${status}: não apresenta histórico`, async () => {
      await load('admin', 'normal', status)
      assert.equal(await evaluate('!!document.querySelector("#history-title")'), false)
    })
    await t.test('estado vazio preservado', async () => {
      await load('admin', 'empty')
      assert.match(await evaluate('document.querySelector("section[aria-labelledby=history-title]").textContent'), /Nenhuma atividade disponível/)
    })
    await t.test('nomes longos, texto seguro, semântica e teclado entre 320 e 1440 px', async () => {
      await load('admin', 'long')
      assert.equal(await evaluate('document.querySelectorAll("section[aria-labelledby=history-title] img,section[aria-labelledby=history-title] script").length'), 0)
      assert.match((await lines())[0][0], /<img src=x onerror=alert\(1\)>/)
      assert.equal(await evaluate('document.querySelectorAll("section[aria-labelledby=history-title] ol > li").length'), 1)
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Atualizar conversa").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'comment-body')
      for (const width of [320, 375, 768, 1024, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("section[aria-labelledby=history-title] p")].every(p=>p.scrollWidth<=p.clientWidth+1)'), true)
        assert.equal(await evaluate('getComputedStyle(document.querySelector("section[aria-labelledby=history-title] li > div > div")).display'), 'flex')
      }
      assert.equal(await evaluate('historyTest.requests.every(r=>r.method==="GET")'), true)
    })
    await t.test('título e data na primeira linha, transição secundária e autor abaixo em todas as larguras', async () => {
      await load()
      for (const width of [320, 375, 768, 1024, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        const layout = await evaluate(`(() => {
          const rows=[...document.querySelectorAll('section[aria-labelledby=history-title] li')];
          const row=rows[2], entry=row.firstElementChild, header=entry.firstElementChild;
          const title=header.querySelector('p'), date=header.querySelector('span'), transition=entry.querySelector(':scope > p'), actor=row.lastElementChild;
          return { title:title.textContent, transition:transition.textContent, actor:actor.textContent,
            headerAligned:Math.abs(title.getBoundingClientRect().top-date.getBoundingClientRect().top)<1,
            dateAtRight:Math.abs(date.getBoundingClientRect().right-row.getBoundingClientRect().right)<1,
            detailGap:transition.getBoundingClientRect().top-header.getBoundingClientRect().bottom,
            actorGap:actor.getBoundingClientRect().top-transition.getBoundingClientRect().bottom,
            titleWeight:getComputedStyle(title).fontWeight, detailWeight:getComputedStyle(transition).fontWeight,
            secondaryColor:getComputedStyle(transition).color===getComputedStyle(actor).color,
            detailHeight:row.getBoundingClientRect().height,
            separator:getComputedStyle(row).borderBottomWidth,
            legacyHasNoTransition:rows.slice(0,2).every(li=>!li.firstElementChild.querySelector(':scope > p')) };
        })()`)
        assert.equal(layout.title, 'Responsável alterado')
        assert.equal(layout.transition, 'Não atribuído → Técnico de teste')
        assert.equal(layout.actor, 'Autor de teste')
        assert.equal(layout.headerAligned, true)
        assert.equal(layout.dateAtRight, true)
        assert.equal(layout.detailGap, 4)
        assert.equal(layout.actorGap, 6)
        assert.ok(Number(layout.titleWeight)>Number(layout.detailWeight))
        assert.equal(layout.secondaryColor, true)
        assert.ok(layout.detailHeight <= 120, `compact row at ${width}`)
        assert.equal(layout.separator, '1px')
        assert.equal(layout.legacyHasNoTransition, true)
      }
      await load('admin', 'partial')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("section[aria-labelledby=history-title] li:last-child > div > p")].map(p=>p.textContent)'), ['Rede → Hardware', 'Baixa → Alta'])
      assert.equal(await evaluate('document.querySelectorAll("section[aria-labelledby=history-title] li:last-child time").length'), 1)
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=history-title] li:last-child > p").textContent'), 'Autor de teste')
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
