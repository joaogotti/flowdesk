import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Transporte inteiramente interceptado: nenhuma requisição alcança o backend.
function transport() {
  const params = new URLSearchParams(location.search)
  const role = params.get('role') || 'admin'
  const assigned = Number(params.get('assigned')) || null
  const date = '2026-10-22T10:00:00Z'
  const labels = { open: 'Aberto', in_progress: 'Em andamento', waiting_requester: 'Aguardando solicitante', resolved: 'Resolvido', closed: 'Fechado', cancelled: 'Cancelado' }
  const user = { id: role === 'technician' ? 8 : 1, role, name: 'Usuário de teste', email: 'teste@example.invalid' }
  const ticket = {
    id: 8, title: 'Chamado de teste', description: 'Descrição de teste', priority: 'medium',
    requester: { id: 2, name: 'Solicitante de teste' }, assignee: assigned ? { id: assigned, name: 'Técnico de teste' } : null,
    category: { id: 1, name: 'Categoria de teste' }, status: { id: 1, code: params.get('status') || 'open', name: labels[params.get('status') || 'open'] },
    created_at: date, updated_at: date, first_response_due_at: '2026-10-23T10:00:00Z',
    resolution_due_at: '2026-10-24T10:00:00Z', first_responded_at: null, resolved_at: null, closed_at: null,
    comments: [{ id: 1, author: { id: 2, name: 'Solicitante de teste' }, body: 'Comentário preservado', created_at: date }],
    activities: [{ id: 1, action: 'created', actor: { id: 2, name: 'Solicitante de teste' }, created_at: date }],
  }
  window.statusTest = { boot: crypto.randomUUID(), ticket, patches: [], gets: 0, patchStatus: 200, getStatus: 200, csrfStatus: 204 }
  window.statusPanel = () => [...document.querySelectorAll('aside dt')].find(item => item.textContent === 'Status')?.nextElementSibling
  window.fetch = async (url, options = {}) => {
    const state = window.statusTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json(user)
    if (path === '/sanctum/csrf-cookie') {
      document.cookie = 'XSRF-TOKEN=status-test'
      return state.csrfStatus === 204 ? new Response(null, { status: 204 }) : json({}, state.csrfStatus)
    }
    if (path === '/api/tickets/8/status' && options.method === 'PATCH') {
      const input = JSON.parse(options.body)
      state.patches.push({ input, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, 120))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus !== 200) return state.patchStatus === 204 ? new Response(null, { status: 204 }) : json({ errors: { status: ['Status indisponível no teste.'] } }, state.patchStatus)
      ticket.status = { id: Object.keys(labels).indexOf(input.status) + 1, code: input.status, name: labels[input.status] }
      ticket.updated_at = new Date(Date.parse(date) + state.patches.length * 60000).toISOString()
      if (input.status === 'resolved') ticket.resolved_at = ticket.updated_at
      else if (input.status === 'in_progress') ticket.resolved_at = null
      if (input.status === 'closed') ticket.closed_at = ticket.updated_at
      ticket.activities.push({ id: ticket.activities.length + 1, action: 'status_changed', actor: { id: user.id, name: user.name }, created_at: ticket.updated_at })
      return json({ id: ticket.id, status: ticket.status, resolved_at: ticket.resolved_at, closed_at: ticket.closed_at, updated_at: ticket.updated_at })
    }
    if (path === '/api/tickets/8') {
      state.gets++
      if (state.getStatus === 'offline') throw TypeError('Offline')
      return json(ticket, state.getStatus)
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('alteração de status no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const click = label => evaluate(`[...statusPanel().querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(label)})?.click()`)
  const select = code => evaluate(`(() => { const input = statusPanel().querySelector('select'); input.value = ${JSON.stringify(code)}; input.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  const submit = () => evaluate(`statusPanel().querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))`)
  const load = async (role = 'admin', assigned = 8, status = 'open') => {
    const boot = await evaluate('window.statusTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&assigned=${assigned || ''}&status=${status}&test=${crypto.randomUUID()}#/chamados/8` })
    await wait(`window.statusTest?.boot !== ${JSON.stringify(boot)} && document.querySelector('h1')?.textContent === 'Chamado de teste'`)
  }
  const open = async () => { await click('Alterar status'); await wait('!!statusPanel().querySelector("select")') }
  const saved = () => wait('statusPanel()?.textContent.includes("Status alterado com sucesso.") && !statusPanel()?.textContent.includes("Atualizando detalhes...")')
  const matrix = { open: ['in_progress', 'cancelled'], in_progress: ['waiting_requester', 'resolved', 'cancelled'], waiting_requester: ['in_progress', 'cancelled'], resolved: ['in_progress', 'closed'] }
  try {
    for (const role of ['admin', 'technician']) for (const [status, targets] of Object.entries(matrix)) await t.test(`${role} em ${status}: somente transições válidas`, async () => {
      await load(role, 8, status)
      await open()
      assert.deepEqual(await evaluate('[...statusPanel().querySelector("select").options].map(option => option.value).filter(Boolean)'), targets)
      assert.equal(await evaluate('statusPanel().querySelector("button[type=submit]").disabled'), true)
      assert.equal(await evaluate('statusTest.patches.length'), 0)
    })
    for (const [role, assigned] of [['admin', null], ['admin', 9], ['technician', 8]]) await t.test(`${role}, responsável ${assigned}: controle disponível`, async () => {
      await load(role, assigned)
      assert.equal(await evaluate('statusPanel().querySelector("button")?.textContent'), 'Alterar status')
    })
    for (const [role, assigned] of [['technician', null], ['technician', 9], ['requester', 8]]) await t.test(`${role}, responsável ${assigned}: somente badge`, async () => {
      await load(role, assigned)
      assert.equal(await evaluate('statusPanel().querySelectorAll("button,select,form").length'), 0)
      assert.equal(await evaluate('statusPanel().textContent'), 'Aberto')
    })
    for (const role of ['admin', 'technician', 'requester']) for (const status of ['closed', 'cancelled']) await t.test(`${role}: estado final ${status} sem controles`, async () => {
      await load(role, 8, status)
      assert.equal(await evaluate('statusPanel().querySelectorAll("button,select,form").length'), 0)
    })
    await t.test('cancelar edição e Escape preservam status; foco volta ao botão', async () => {
      await load()
      await open()
      await select('in_progress')
      await click('Cancelar')
      await wait('!statusPanel().querySelector("select") && document.activeElement.textContent === "Alterar status"')
      await open()
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await wait('!statusPanel().querySelector("select")')
      assert.equal(await evaluate('statusTest.patches.length'), 0)
      assert.equal(await evaluate('statusTest.ticket.status.code'), 'open')
    })
    for (const [from, to] of [['open', 'cancelled'], ['resolved', 'closed']]) await t.test(`${to}: confirmação explícita obrigatória e cancelável`, async () => {
      await load('admin', 8, from)
      await open()
      await select(to)
      assert.equal(await evaluate('statusPanel().querySelector("button[type=submit]").disabled'), true)
      await submit()
      assert.equal(await evaluate('statusTest.patches.length'), 0)
      await evaluate('statusPanel().querySelector("input[type=checkbox]").click()')
      await click('Cancelar')
      assert.equal(await evaluate('statusTest.patches.length'), 0)
      await open()
      await select(to)
      assert.equal(await evaluate('statusPanel().querySelector("input[type=checkbox]").checked'), false)
      await evaluate('statusPanel().querySelector("input[type=checkbox]").click()')
      await submit()
      await saved()
      assert.equal(await evaluate('statusTest.ticket.status.code'), to)
      assert.equal(await evaluate('statusPanel().querySelectorAll("button,select,form").length'), 0)
    })
    await t.test('confirmação de cancelamento é limpa ao trocar a seleção', async () => {
      await load()
      await open()
      await select('cancelled')
      await evaluate('statusPanel().querySelector("input[type=checkbox]").click()')
      await select('in_progress')
      await select('cancelled')
      assert.equal(await evaluate('statusPanel().querySelector("input[type=checkbox]").checked'), false)
    })
    await t.test('fluxo completo, reabertura e GET atualizam badge, histórico, datas e preservam atribuição/conversa/SLA', async () => {
      await load()
      const boot = await evaluate('statusTest.boot')
      const preserved = await evaluate('JSON.stringify({comments:statusTest.ticket.comments,assignee:statusTest.ticket.assignee,first_response_due_at:statusTest.ticket.first_response_due_at,resolution_due_at:statusTest.ticket.resolution_due_at})')
      await evaluate('(() => { const input = document.querySelector("textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"Rascunho preservado"); input.dispatchEvent(new Event("input",{bubbles:true})); })()')
      for (const code of ['in_progress', 'waiting_requester', 'in_progress', 'resolved', 'in_progress', 'resolved', 'closed']) {
        const count = await evaluate('statusTest.patches.length')
        await open()
        await select(code)
        assert.equal(await evaluate('statusTest.patches.length'), count)
        if (code === 'closed') await evaluate('statusPanel().querySelector("input[type=checkbox]").click()')
        await submit()
        await saved()
        assert.equal(await evaluate('statusTest.ticket.status.code'), code)
        assert.equal(await evaluate('statusPanel().textContent.includes(statusTest.ticket.status.name)'), true)
        assert.equal(await evaluate('document.body.textContent.includes("Resolução registrada")'), ['resolved', 'closed'].includes(code))
        assert.equal(await evaluate('document.body.textContent.includes("Fechamento registrado")'), code === 'closed')
        if (['in_progress', 'waiting_requester'].includes(code)) assert.equal(await evaluate('document.querySelector("textarea").value'), 'Rascunho preservado')
      }
      assert.equal(await evaluate('statusTest.gets'), 8)
      assert.equal(await evaluate('statusTest.patches.length'), 7)
      assert.equal(await evaluate('statusTest.patches.every(patch => patch.credentials === "include" && patch.csrf === "status-test" && Object.keys(patch.input).join() === "status")'), true)
      assert.equal(await evaluate('statusTest.boot'), boot)
      assert.equal(await evaluate('JSON.stringify({comments:statusTest.ticket.comments,assignee:statusTest.ticket.assignee,first_response_due_at:statusTest.ticket.first_response_due_at,resolution_due_at:statusTest.ticket.resolution_due_at})'), preserved)
      assert.equal(await evaluate('document.querySelectorAll("article").length'), 1)
      assert.equal(await evaluate('[...document.querySelectorAll("li")].filter(item => item.textContent.includes("Status alterado")).length'), 7)
    })
    await t.test('erros HTTP e de rede preservam seleção; não simulam sucesso nem consultam GET automaticamente', async () => {
      await load()
      await open()
      await select('in_progress')
      for (const status of [401, 403, 404, 409, 419, 422, 500, 201, 202, 204, 'offline']) {
        const count = await evaluate('statusTest.patches.length')
        await evaluate(`statusTest.patchStatus = ${JSON.stringify(status)}`)
        await submit()
        await wait(`statusTest.patches.length === ${count + 1} && !statusPanel().querySelector('select').disabled && !!statusPanel().querySelector('[role=alert]')`)
        assert.equal(await evaluate('statusPanel().querySelector("select").value'), 'in_progress')
        assert.equal(await evaluate('statusPanel().textContent.includes("Status alterado com sucesso.")'), false)
        assert.equal(await evaluate('statusTest.gets'), 1)
        assert.equal(await evaluate('statusTest.ticket.status.code'), 'open')
      }
    })
    await t.test('falha de CSRF não envia PATCH e mantém seleção', async () => {
      await load()
      await open()
      await select('in_progress')
      await evaluate('statusTest.csrfStatus = 419')
      await submit()
      await wait('!!statusPanel().querySelector("[role=alert]")')
      assert.equal(await evaluate('statusTest.patches.length'), 0)
      assert.equal(await evaluate('statusPanel().querySelector("select").value'), 'in_progress')
    })
    await t.test('dois submits síncronos geram somente um PATCH; controles bloqueados durante envio', async () => {
      await load()
      await open()
      await select('in_progress')
      await evaluate('for(let i=0;i<2;i++) statusPanel().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
      await wait('statusTest.patches.length === 1')
      assert.equal(await evaluate('statusPanel().querySelector("select").disabled'), true)
      assert.equal(await evaluate('[...statusPanel().querySelectorAll("button")].every(button => button.disabled)'), true)
      await saved()
      assert.equal(await evaluate('statusTest.patches.length'), 1)
    })
    for (const getStatus of [401, 403, 404, 419, 503, 'offline']) await t.test(`PATCH confirmado e GET ${getStatus}: repetir consulta envia somente GET`, async () => {
      await load()
      await open()
      await select('in_progress')
      await evaluate(`statusTest.getStatus = ${JSON.stringify(getStatus)}`)
      await submit()
      await wait('statusPanel().textContent.includes("O status foi alterado, mas os detalhes não puderam ser atualizados.")')
      assert.equal(await evaluate('statusPanel().textContent.includes("Status alterado com sucesso.")'), true)
      assert.equal(await evaluate('[...statusPanel().querySelectorAll("button")].some(button => button.textContent === "Alterar status")'), false)
      await click('Atualizar detalhes')
      await wait('statusTest.gets === 3 && !statusPanel().querySelector("button").disabled')
      assert.equal(await evaluate('statusTest.patches.length'), 1)
      await evaluate('statusTest.getStatus = 200')
      await click('Atualizar detalhes')
      await wait('statusPanel().textContent.includes("Em andamento") && !statusPanel().textContent.includes("O status foi alterado, mas")')
      assert.equal(await evaluate('statusTest.patches.length'), 1)
      assert.equal(await evaluate('statusTest.gets'), 4)
    })
    await t.test('GET após erro reavalia permissão de técnico sem reenviar PATCH', async () => {
      await load('technician', 8)
      await open()
      await select('in_progress')
      await evaluate('statusTest.patchStatus = 404; statusTest.ticket.assignee = {id:9,name:"Outro técnico"}')
      await submit()
      await wait('!!statusPanel().querySelector("[role=alert]")')
      await click('Atualizar detalhes')
      await wait('!statusPanel().querySelector("select")')
      assert.equal(await evaluate('statusTest.patches.length'), 1)
    })
    await t.test('responsividade, rótulos acessíveis e operação por teclado', async () => {
      await load()
      await open()
      assert.equal(await evaluate('document.activeElement === statusPanel().querySelector("select")'), true)
      assert.equal(await evaluate('statusPanel().querySelector("select").labels[0].textContent'), 'Novo status')
      await select('cancelled')
      const ax = await send('Accessibility.getFullAXTree')
      assert.equal(ax.nodes.some(node => node.role?.value === 'combobox' && node.name?.value === 'Novo status'), true)
      assert.equal(ax.nodes.some(node => node.role?.value === 'checkbox' && node.name?.value.includes('Confirmo que desejo cancelar')), true)
      await evaluate('statusPanel().querySelector("input[type=checkbox]").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
      assert.equal(await evaluate('statusPanel().querySelector("input[type=checkbox]").checked'), true)
      for (const width of [1440, 1024, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
        assert.equal(await evaluate('[...statusPanel().querySelectorAll("select,button")].every(element => { const rect=element.getBoundingClientRect(); return rect.width > 0 && rect.right <= innerWidth && rect.left >= 0 })'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
