import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Dados exclusivamente de teste; todo transporte da aplicação é interceptado.
function transport() {
  const params = new URLSearchParams(location.search)
  const role = params.get('role') || 'admin'
  const assigned = Number(params.get('assigned')) || null
  const date = '2026-10-21T20:43:42Z'
  const user = { id: role === 'technician' ? 8 : 1, role, name: 'Usuário de teste', email: 'teste@example.invalid' }
  const technicians = [{ id: 8, name: 'Técnico A de teste' }, { id: 9, name: 'Técnico B de teste' }]
  const ticket = {
    id: 8, title: 'Chamado de teste', description: 'Descrição de teste', priority: 'medium',
    requester: { id: 2, name: 'Solicitante de teste' }, assignee: technicians.find(item => item.id === assigned) || null,
    category: { id: 1, name: 'Categoria de teste' }, status: { id: 1, code: params.get('status') || 'open', name: 'Status de teste' },
    created_at: date, updated_at: date, first_response_due_at: '2026-10-22T20:43:42Z',
    resolution_due_at: '2026-10-23T20:43:42Z', first_responded_at: null, resolved_at: null, closed_at: null,
    comments: [{ id: 1, author: { id: 2, name: 'Solicitante de teste' }, body: 'Comentário preservado', created_at: date }],
    activities: [{ id: 1, action: 'created', actor: { id: 2, name: 'Solicitante de teste' }, created_at: date }],
  }
  window.assignmentTest = { boot: crypto.randomUUID(), user, ticket, technicians, patches: [], technicianGets: 0, detailGets: 0, patchStatus: 200, technicianStatus: 200, failGet: false }
  window.assignmentPanel = () => document.querySelector('aside[aria-label="Informações do chamado"]')
  window.fetch = async (url, options = {}) => {
    const state = window.assignmentTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json(user)
    if (path === '/sanctum/csrf-cookie') { document.cookie = 'XSRF-TOKEN=test-only'; return new Response(null, { status: 204 }) }
    if (path === '/api/technicians') {
      state.technicianGets++
      await new Promise(resolve => setTimeout(resolve, 100))
      return json({ data: state.technicians }, state.technicianStatus)
    }
    if (path === '/api/tickets/8/assignment' && options.method === 'PATCH') {
      const input = JSON.parse(options.body)
      state.patches.push(input)
      await new Promise(resolve => setTimeout(resolve, 150))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus !== 200) return json({ errors: { assigned_to: ['Técnico indisponível no teste.'] } }, state.patchStatus)
      ticket.assignee = technicians.find(item => item.id === input.assigned_to) || null
      ticket.updated_at = '2026-10-21T21:00:00Z'
      ticket.activities.push({ id: ticket.activities.length + 1, action: 'assignment_changed', actor: { id: user.id, name: user.name }, created_at: ticket.updated_at })
      return json({ id: ticket.id, assignee: ticket.assignee, updated_at: ticket.updated_at })
    }
    if (path === '/api/tickets/8') {
      state.detailGets++
      if (state.failGet) return json({}, 503)
      return json(ticket)
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('atribuição de responsáveis no navegador', { skip: !browserExecutable, timeout: 90000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const click = label => evaluate(`[...document.querySelectorAll('aside button')].find(button => button.textContent === ${JSON.stringify(label)})?.click()`)
  const select = id => evaluate(`(() => { const input = document.querySelector('#assignment-technician'); input.value = ${JSON.stringify(String(id))}; input.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  const submit = () => evaluate(`document.querySelector('form[aria-label="Alterar responsável"]').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))`)
  const load = async (role = 'admin', assigned = null, status = 'open') => {
    const boot = await evaluate('window.assignmentTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&assigned=${assigned || ''}&status=${status}&test=${crypto.randomUUID()}#/chamados/8` })
    await wait(`window.assignmentTest?.boot !== ${JSON.stringify(boot)} && document.querySelector('h1')?.textContent === 'Chamado de teste'`)
  }
  const open = async () => { await click('Alterar responsável'); await wait('!!document.querySelector("#assignment-technician")') }
  const saved = () => wait('assignmentPanel()?.textContent.includes("Atribuição salva com sucesso.") && !assignmentPanel()?.textContent.includes("Atualizando detalhes...")')
  try {
    await t.test('admin carrega técnicos ao editar e exige confirmação explícita', async () => {
      await load()
      assert.equal(await evaluate('assignmentTest.technicianGets'), 0)
      await open()
      assert.equal(await evaluate('assignmentTest.technicianGets'), 1)
      assert.deepEqual(await evaluate('[...document.querySelector("#assignment-technician").options].filter(item => item.value).map(item => item.textContent)'), ['Técnico A de teste', 'Técnico B de teste'])
      await select(8)
      assert.equal(await evaluate('assignmentTest.patches.length'), 0)
      await submit()
      await saved()
      assert.deepEqual(await evaluate('assignmentTest.patches'), [{ assigned_to: 8 }])
      assert.equal(await evaluate('assignmentTest.detailGets'), 2)
      assert.equal(await evaluate('assignmentPanel().textContent.includes("Técnico A de teste")'), true)
      assert.equal(await evaluate('document.body.textContent.includes("Responsável alterado")'), true)
      assert.equal(await evaluate('document.body.textContent.includes("assignment_changed")'), false)
      assert.equal(await evaluate('document.body.textContent.includes("Chamado criado")'), true)
      assert.equal(await evaluate('document.querySelectorAll("article").length'), 1)
    })
    await t.test('admin transfere responsável e preserva comentários, rascunho, status e SLA', async () => {
      await load('admin', 8)
      const before = await evaluate('JSON.stringify({comments:assignmentTest.ticket.comments,status:assignmentTest.ticket.status,priority:assignmentTest.ticket.priority,first_response_due_at:assignmentTest.ticket.first_response_due_at,resolution_due_at:assignmentTest.ticket.resolution_due_at})')
      await evaluate('(() => {const input=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"Rascunho preservado");input.dispatchEvent(new Event("input",{bubbles:true}));})()')
      await open()
      await select(9)
      await submit()
      await saved()
      assert.deepEqual(await evaluate('assignmentTest.patches'), [{ assigned_to: 9 }])
      assert.equal(await evaluate('assignmentPanel().textContent.includes("Técnico B de teste")'), true)
      assert.equal(await evaluate('document.querySelector("textarea").value'), 'Rascunho preservado')
      assert.equal(await evaluate('JSON.stringify({comments:assignmentTest.ticket.comments,status:assignmentTest.ticket.status,priority:assignmentTest.ticket.priority,first_response_due_at:assignmentTest.ticket.first_response_due_at,resolution_due_at:assignmentTest.ticket.resolution_due_at})'), before)
    })
    await t.test('admin remove atribuição explicitamente', async () => {
      await load('admin', 8)
      await open()
      await click('Remover atribuição')
      await saved()
      assert.deepEqual(await evaluate('assignmentTest.patches'), [{ assigned_to: null }])
      assert.equal(await evaluate('assignmentPanel().textContent.includes("Não atribuído")'), true)
    })
    await t.test('cancelamento não envia PATCH nem altera responsável', async () => {
      await load('admin', 8)
      await open()
      await select(9)
      await click('Cancelar')
      await wait('!document.querySelector("#assignment-technician")')
      assert.equal(await evaluate('assignmentTest.patches.length'), 0)
      assert.equal(await evaluate('assignmentTest.ticket.assignee.id'), 8)
    })
    await t.test('técnico assume somente para si, sem carregar lista administrativa', async () => {
      await load('technician')
      await click('Assumir chamado')
      await saved()
      assert.deepEqual(await evaluate('assignmentTest.patches'), [{ assigned_to: 8 }])
      assert.equal(await evaluate('assignmentTest.technicianGets'), 0)
      assert.equal(await evaluate('[...assignmentPanel().querySelectorAll("button")].some(button => /Alterar responsável|Assumir chamado|Remover atribuição/.test(button.textContent))'), false)
    })
    for (const assigned of [8, 9]) await t.test(`técnico vê atribuição #${assigned} sem controles`, async () => {
      await load('technician', assigned)
      assert.equal(await evaluate('[...assignmentPanel().querySelectorAll("button")].filter(button => /Alterar responsável|Assumir chamado|Remover atribuição/.test(button.textContent)).length'), 0)
      assert.equal(await evaluate('assignmentTest.technicianGets'), 0)
    })
    await t.test('solicitante somente visualiza responsável', async () => {
      await load('requester', 8)
      assert.equal(await evaluate('[...assignmentPanel().querySelectorAll("button")].filter(button => /Alterar responsável|Assumir chamado|Remover atribuição/.test(button.textContent)).length'), 0)
      assert.equal(await evaluate('assignmentTest.technicianGets'), 0)
    })
    for (const role of ['admin', 'technician']) for (const status of ['resolved', 'closed', 'cancelled']) await t.test(`${role}: ${status} sem controles`, async () => {
      await load(role, null, status)
      assert.equal(await evaluate('[...assignmentPanel().querySelectorAll("button")].filter(button => /Alterar responsável|Assumir chamado|Remover atribuição/.test(button.textContent)).length'), 0)
      assert.equal(await evaluate('assignmentTest.technicianGets'), 0)
    })
    await t.test('erros HTTP e rede preservam seleção e responsável atual', async () => {
      await load('admin', 8)
      await open()
      await select(9)
      for (const status of [403, 404, 409, 419, 422, 500, 'offline']) {
        const count = await evaluate('assignmentTest.patches.length')
        await evaluate(`assignmentTest.patchStatus = ${JSON.stringify(status)}`)
        await submit()
        await wait(`assignmentTest.patches.length === ${count + 1} && !document.querySelector('#assignment-technician').disabled && !!document.querySelector('#assignment-error')`)
        assert.equal(await evaluate('document.querySelector("#assignment-technician").value'), '9')
        assert.equal(await evaluate('assignmentTest.ticket.assignee.id'), 8)
        assert.equal(await evaluate('assignmentPanel().textContent.includes("Atribuição salva com sucesso.")'), false)
      }
    })
    await t.test('bloqueia envios duplicados na mesma execução', async () => {
      await load()
      await open()
      await select(8)
      await evaluate('for(let i=0;i<2;i++) assignmentPanel().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
      await saved()
      assert.equal(await evaluate('assignmentTest.patches.length'), 1)
    })
    await t.test('PATCH salvo e GET falho preservam confirmação; retry executa somente GET', async () => {
      await load()
      await open()
      await select(8)
      await evaluate('assignmentTest.failGet = true')
      await submit()
      await wait('assignmentPanel().textContent.includes("A alteração foi salva, mas os detalhes não puderam ser atualizados.")')
      assert.equal(await evaluate('assignmentPanel().textContent.includes("Atribuição salva com sucesso.")'), true)
      assert.equal(await evaluate('assignmentPanel().textContent.includes("Não atribuído")'), true)
      await evaluate('assignmentTest.failGet = false')
      await click('Atualizar detalhes')
      await wait('assignmentPanel().textContent.includes("Técnico A de teste")')
      assert.equal(await evaluate('assignmentTest.patches.length'), 1)
      assert.equal(await evaluate('assignmentTest.detailGets'), 3)
    })
    await t.test('erro e lista vazia de técnicos impedem confirmação e permitem cancelar', async () => {
      await load()
      await evaluate('assignmentTest.technicianStatus = 503')
      await click('Alterar responsável')
      await wait('assignmentPanel().textContent.includes("Não foi possível carregar os técnicos.")')
      assert.equal(await evaluate('assignmentPanel().querySelector("button[type=submit]").disabled'), true)
      await evaluate('assignmentTest.technicianStatus = 200; assignmentTest.technicians = []')
      await click('Tentar carregar técnicos')
      await wait('assignmentPanel().textContent.includes("Nenhum técnico ativo disponível")')
      assert.equal(await evaluate('assignmentTest.patches.length'), 0)
      await click('Cancelar')
    })
    await t.test('painel lateral responsivo em desktop e mobile', async () => {
      await load()
      await open()
      for (const width of [1440, 1024, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
