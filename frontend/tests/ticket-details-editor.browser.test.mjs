import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Todos os endpoints são interceptados antes da aplicação iniciar, sem acesso ao banco.
function transport() {
  const params = new URLSearchParams(location.search)
  const role = params.get('role') || 'admin'
  const assigned = Number(params.get('assigned')) || null
  const date = '2026-10-22T10:00:00Z'
  const user = { id: role === 'technician' ? 8 : 1, role, name: 'Usuário de teste', email: 'teste@example.invalid' }
  const categories = [{ id: 1, name: 'Categoria atual' }, { id: 2, name: 'Categoria destino' }, { id: 3, name: 'Outra categoria ativa' }]
  const priority = params.get('priority') || 'medium'
  const ticket = {
    id: 8, title: 'Chamado de teste', description: 'Descrição de teste', priority,
    requester: { id: 2, name: 'Solicitante de teste' }, assignee: assigned ? { id: assigned, name: 'Técnico de teste' } : null,
    category: params.has('missing') ? { id: 99, name: 'Categoria antiga' } : categories[0], status: { id: 1, code: params.get('status') || 'open', name: 'Aberto' },
    created_at: date, updated_at: date, first_response_due_at: '2026-10-22T14:00:00Z', resolution_due_at: '2026-10-23T10:00:00Z',
    first_responded_at: '2026-10-22T10:05:00Z', resolved_at: null, closed_at: null,
    comments: [{ id: 1, author: { id: 2, name: 'Solicitante de teste' }, body: 'Comentário preservado', created_at: date }],
    activities: [{ id: 1, action: 'created', actor: { id: 2, name: 'Solicitante de teste' }, created_at: date }],
  }
  window.editorTest = { boot: crypto.randomUUID(), ticket, categories, patches: [], gets: 0, categoryGets: 0, patchStatus: 200, getStatus: 200, categoryStatus: 200, csrfStatus: 204, categoryDelay: 60, holdDetails: false }
  window.editorPanel = () => document.querySelector('[aria-label="Edição das informações do chamado"]')
  window.infoRow = label => [...document.querySelectorAll('aside dt')].find(item => item.textContent === label)?.nextElementSibling
  window.fetch = async (url, options = {}) => {
    const state = window.editorTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json(user)
    if (path === '/sanctum/csrf-cookie') {
      document.cookie = 'XSRF-TOKEN=editor-test'
      return state.csrfStatus === 204 ? new Response(null, { status: 204 }) : json({}, state.csrfStatus)
    }
    if (path === '/api/categories') {
      state.categoryGets++
      await new Promise(resolve => setTimeout(resolve, state.categoryDelay))
      if (state.categoryStatus === 'offline') throw TypeError('Offline')
      if (state.categoryStatus === 'invalid') return json({ data: null })
      return json({ data: state.categories }, state.categoryStatus)
    }
    if (path === '/api/tickets/8/details' && options.method === 'PATCH') {
      const input = JSON.parse(options.body)
      state.patches.push({ input, csrf: options.headers.get('X-XSRF-TOKEN'), credentials: options.credentials })
      await new Promise(resolve => setTimeout(resolve, 150))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus !== 200) return state.patchStatus === 204 ? new Response(null, { status: 204 }) : json({ errors: { category_id: ['Categoria indisponível no teste.'], priority: ['Prioridade indisponível no teste.'] } }, state.patchStatus)
      if ('category_id' in input) ticket.category = state.categories.find(item => item.id === input.category_id)
      if ('priority' in input) {
        ticket.priority = input.priority
        const minutes = { low: [480, 4320], medium: [240, 1440], high: [60, 480], urgent: [15, 240] }[input.priority]
        ticket.first_response_due_at = new Date(Date.parse(date) + minutes[0] * 60000).toISOString()
        ticket.resolution_due_at = new Date(Date.parse(date) + minutes[1] * 60000).toISOString()
      }
      ticket.updated_at = '2026-10-22T11:00:00Z'
      ticket.activities.push({ id: ticket.activities.length + 1, action: 'details_changed', actor: { id: user.id, name: user.name }, created_at: ticket.updated_at, changes: { internal: 'internal-test-marker' } })
      return json({ id: ticket.id, category: ticket.category, priority: ticket.priority, updated_at: ticket.updated_at })
    }
    if (path === '/api/tickets/8') {
      state.gets++
      if (state.holdDetails) await new Promise(resolve => { state.releaseDetails = resolve })
      if (state.getStatus === 'offline') throw TypeError('Offline')
      return json(ticket, state.getStatus)
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('edição de categoria e prioridade no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const click = label => evaluate(`[...editorPanel().querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(label)})?.click()`)
  const select = (field, value) => evaluate(`(() => { const input = editorPanel().querySelector('select[name=${field}]'); input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  const submit = () => evaluate(`editorPanel().querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
  const load = async (role = 'admin', assigned = 8, status = 'open', extra = '') => {
    const boot = await evaluate('window.editorTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&assigned=${assigned || ''}&status=${status}&test=${crypto.randomUUID()}&${extra}#/chamados/8` })
    await wait(`window.editorTest?.boot !== ${JSON.stringify(boot)} && document.querySelector('h1')?.textContent === 'Chamado de teste'`)
  }
  const open = async () => { await click('Editar informações'); await wait('!!editorPanel().querySelector("select[name=category_id]") && !editorPanel().querySelector("form").getAttribute("aria-busy").includes("true")') }
  const saved = () => wait('editorPanel()?.textContent.includes("Informações salvas com sucesso.") && !editorPanel()?.textContent.includes("Atualizando detalhes...")')
  try {
    for (const role of ['admin', 'technician']) for (const status of ['open', 'in_progress', 'waiting_requester']) await t.test(`${role} em ${status}: edição disponível e carregamento sob demanda`, async () => {
      await load(role, 8, status)
      assert.equal(await evaluate('editorTest.categoryGets'), 0)
      assert.equal(await evaluate('infoRow("Categoria").textContent'), 'Categoria atual')
      assert.equal(await evaluate('infoRow("Prioridade").textContent'), 'Média')
      await open()
      assert.equal(await evaluate('editorTest.categoryGets'), 1)
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").value'), '1')
      assert.deepEqual(await evaluate('[...editorPanel().querySelector("select[name=priority]").options].map(option => [option.value,option.textContent])'), [['low', 'Baixa'], ['medium', 'Média'], ['high', 'Alta'], ['urgent', 'Crítica']])
      assert.equal(await evaluate('editorTest.patches.length'), 0)
    })
    for (const assigned of [null, 9]) await t.test(`admin pode editar responsável ${assigned}`, async () => {
      await load('admin', assigned)
      await open()
    })
    for (const [role, assigned] of [['technician', null], ['technician', 9], ['requester', 8]]) await t.test(`${role}, responsável ${assigned}: sem edição`, async () => {
      await load(role, assigned)
      assert.equal(await evaluate('!!editorPanel()'), false)
      assert.equal(await evaluate('editorTest.categoryGets'), 0)
    })
    for (const role of ['admin', 'technician']) for (const status of ['resolved', 'closed', 'cancelled']) await t.test(`${role} em ${status}: sem edição`, async () => {
      await load(role, 8, status)
      assert.equal(await evaluate('!!editorPanel()'), false)
      assert.equal(await evaluate('editorTest.categoryGets'), 0)
    })
    await t.test('sem alterações ou ao reverter seleções não envia CSRF nem PATCH', async () => {
      await load()
      await open()
      assert.equal(await evaluate('editorPanel().querySelector("button[type=submit]").disabled'), true)
      await submit()
      await select('category_id', 2)
      await select('priority', 'high')
      await select('category_id', 1)
      await select('priority', 'medium')
      await submit()
      assert.equal(await evaluate('editorTest.patches.length'), 0)
      assert.equal(await evaluate('editorPanel().querySelector("button[type=submit]").disabled'), true)
    })
    await t.test('cancelamento por botão e Escape não altera dados e restaura foco', async () => {
      await load()
      await open()
      await select('category_id', 2)
      await select('priority', 'high')
      await click('Cancelar')
      await wait('document.activeElement.textContent === "Editar informações"')
      await open()
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").value'), '1')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=priority]").value'), 'medium')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await wait('!editorPanel().querySelector("form")')
      assert.equal(await evaluate('editorTest.patches.length'), 0)
    })
    for (const [mode, expected] of [['category', { category_id: 2 }], ['priority', { priority: 'high' }], ['both', { category_id: 2, priority: 'high' }]]) await t.test(`${mode}: confirmação envia apenas diferenças, GET atualiza dados e preserva recursos existentes`, async () => {
      await load()
      const boot = await evaluate('editorTest.boot')
      const preserved = await evaluate('JSON.stringify({comments:editorTest.ticket.comments,assignee:editorTest.ticket.assignee,status:editorTest.ticket.status,first_responded_at:editorTest.ticket.first_responded_at,resolved_at:editorTest.ticket.resolved_at,closed_at:editorTest.ticket.closed_at})')
      const sla = await evaluate('JSON.stringify([editorTest.ticket.first_response_due_at,editorTest.ticket.resolution_due_at])')
      await evaluate('(() => {const input=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"Rascunho preservado");input.dispatchEvent(new Event("input",{bubbles:true}));})()')
      await open()
      if (mode !== 'priority') await select('category_id', 2)
      if (mode !== 'category') await select('priority', 'high')
      assert.equal(await evaluate('editorTest.patches.length'), 0)
      await click('Salvar alterações')
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches'), [{ input: expected, csrf: 'editor-test', credentials: 'include' }])
      assert.equal(await evaluate('editorTest.gets'), 2)
      assert.equal(await evaluate('infoRow("Categoria").textContent'), mode === 'priority' ? 'Categoria atual' : 'Categoria destino')
      assert.equal(await evaluate('infoRow("Prioridade").textContent'), mode === 'category' ? 'Média' : 'Alta')
      assert.equal(await evaluate('JSON.stringify([editorTest.ticket.first_response_due_at,editorTest.ticket.resolution_due_at])') === sla, mode === 'category')
      assert.equal(await evaluate('document.querySelectorAll("time").length > 0'), true)
      assert.equal(await evaluate('document.body.textContent.includes("Informações alteradas")'), true)
      assert.equal(await evaluate('document.body.textContent.includes("internal-test-marker") || document.body.textContent.includes("details_changed")'), false)
      assert.equal(await evaluate('JSON.stringify({comments:editorTest.ticket.comments,assignee:editorTest.ticket.assignee,status:editorTest.ticket.status,first_responded_at:editorTest.ticket.first_responded_at,resolved_at:editorTest.ticket.resolved_at,closed_at:editorTest.ticket.closed_at})'), preserved)
      assert.equal(await evaluate('document.querySelector("textarea").value'), 'Rascunho preservado')
      assert.equal(await evaluate('document.querySelectorAll("article").length'), 1)
      assert.equal(await evaluate('editorTest.boot'), boot)
    })
    for (const priority of ['low', 'medium', 'high', 'urgent']) await t.test(`prioridade ${priority}: código correto no PATCH`, async () => {
      await load('admin', 8, 'open', `priority=${priority === 'medium' ? 'low' : 'medium'}`)
      await open()
      await select('priority', priority)
      await submit()
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches.map(item=>item.input)'), [{ priority }])
    })
    await t.test('categoria atual ausente da lista ativa permite prioridade ou troca para categoria ativa', async () => {
      await load('admin', 8, 'open', 'missing=1')
      await open()
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").value'), '99')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").selectedOptions[0].disabled'), true)
      await select('priority', 'high')
      await submit()
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches.map(item=>item.input)'), [{ priority: 'high' }])
      await open()
      await select('category_id', 2)
      await submit()
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches[1].input'), { category_id: 2 })
    })
    for (const status of [403, 419, 503, 'offline', 'invalid', 'empty']) await t.test(`categorias ${status}: erro recuperável, sem atribuir categoria inválida; prioridade pode ser editada`, async () => {
      await load()
      await evaluate(status === 'empty' ? 'editorTest.categories=[]' : `editorTest.categoryStatus=${JSON.stringify(status)}`)
      await open()
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").disabled'), true)
      await select('priority', 'high')
      await submit()
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches[0].input'), { priority: 'high' })
      await open()
      await evaluate('editorTest.categoryStatus=200; editorTest.categories=[{id:1,name:"Categoria atual"},{id:2,name:"Categoria destino"}]')
      await click('Recarregar categorias')
      await wait('!editorPanel().querySelector("select[name=category_id]").disabled')
      await select('category_id', 2)
      await submit()
      await saved()
    })
    for (const status of [403, 404, 409, 419, 422, 500, 201, 202, 204, 'offline']) await t.test(`PATCH ${status}: preserva seleções sem sucesso falso nem retry automático`, async () => {
      await load()
      await open()
      await select('category_id', 2)
      await select('priority', 'high')
      await evaluate(`editorTest.patchStatus=${JSON.stringify(status)}`)
      await submit()
      await wait('!!editorPanel().querySelector("[role=alert]") && !editorPanel().querySelector("select[name=priority]").disabled')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").value'), '2')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=priority]").value'), 'high')
      assert.equal(await evaluate('editorPanel().textContent.includes("Informações salvas com sucesso.")'), false)
      assert.equal(await evaluate('editorTest.patches.length'), 1)
      assert.equal(await evaluate('editorTest.gets'), 1)
      if ([403, 404, 409].includes(status)) assert.equal(await evaluate('editorPanel().querySelector("button[type=submit]").disabled'), true)
      if (status === 422) {
        assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").getAttribute("aria-invalid")'), 'true')
        assert.equal(await evaluate('editorPanel().textContent.includes("Categoria indisponível no teste.") && editorPanel().textContent.includes("Prioridade indisponível no teste.")'), true)
      }
    })
    await t.test('categoria desativada após carregar: 422, recarregar lista preserva escolha e exige destino disponível', async () => {
      await load()
      await open()
      await select('category_id', 2)
      await select('priority', 'high')
      await evaluate('editorTest.patchStatus=422')
      await submit()
      await wait('editorPanel().textContent.includes("Categoria indisponível no teste.")')
      await evaluate('editorTest.categories=[{id:1,name:"Categoria atual"},{id:3,name:"Outra categoria ativa"}]')
      await click('Recarregar categorias')
      await wait('editorTest.categoryGets===2 && !editorPanel().querySelector("select[name=category_id]").disabled')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=category_id]").value'), '2')
      assert.equal(await evaluate('editorPanel().querySelector("button[type=submit]").disabled'), true)
      await select('category_id', 3)
      await evaluate('editorTest.patchStatus=200')
      await submit()
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches[1].input'), { category_id: 3, priority: 'high' })
    })
    await t.test('duplo submit síncrono gera um PATCH; campos e cancelamento bloqueados durante envio', async () => {
      await load()
      await open()
      await select('priority', 'high')
      await evaluate('for(let i=0;i<2;i++) editorPanel().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
      await wait('editorTest.patches.length===1')
      assert.equal(await evaluate('[...editorPanel().querySelectorAll("select,button")].every(item=>item.disabled)'), true)
      await saved()
      assert.equal(await evaluate('editorTest.patches.length'), 1)
    })
    for (const getStatus of [403, 404, 419, 503, 'offline']) await t.test(`PATCH confirmado e GET ${getStatus}: nova consulta nunca reenvia PATCH`, async () => {
      await load()
      await open()
      await select('category_id', 2)
      await select('priority', 'high')
      await evaluate(`editorTest.getStatus=${JSON.stringify(getStatus)}`)
      await submit()
      await wait('editorPanel().textContent.includes("As informações foram salvas, mas os detalhes não puderam ser atualizados.")')
      assert.equal(await evaluate('editorPanel().textContent.includes("Informações salvas com sucesso.")'), true)
      assert.equal(await evaluate('[...editorPanel().querySelectorAll("button")].some(item=>item.textContent==="Editar informações")'), false)
      await click('Atualizar detalhes')
      await wait('editorTest.gets===3 && !editorPanel().querySelector("button").disabled')
      await evaluate('editorTest.getStatus=200')
      await click('Atualizar detalhes')
      await wait('infoRow("Categoria").textContent==="Categoria destino" && !editorPanel().textContent.includes("As informações foram salvas, mas")')
      assert.equal(await evaluate('editorTest.patches.length'), 1)
      assert.equal(await evaluate('editorTest.gets'), 4)
    })
    await t.test('409 exige consultar novamente e preserva rascunho; estado encerrado remove edição', async () => {
      await load()
      await open()
      await select('priority', 'high')
      await evaluate('editorTest.patchStatus=409; editorTest.ticket.status={id:5,code:"closed",name:"Fechado"}')
      await submit()
      await wait('!!editorPanel().querySelector("[role=alert]")')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=priority]").value'), 'high')
      await click('Atualizar detalhes')
      await wait('!editorPanel()')
      assert.equal(await evaluate('editorTest.patches.length'), 1)
    })
    await t.test('perda de atribuição: consulta após 403 remove controles do técnico', async () => {
      await load('technician', 8)
      await open()
      await select('priority', 'high')
      await evaluate('editorTest.patchStatus=403; editorTest.ticket.assignee={id:9,name:"Outro técnico"}')
      await submit()
      await wait('!!editorPanel().querySelector("[role=alert]")')
      await click('Atualizar detalhes')
      await wait('!editorPanel()')
      assert.equal(await evaluate('editorTest.patches.length'), 1)
    })
    await t.test('atualização concorrente de categoria não é revertida por edição apenas da prioridade', async () => {
      await load()
      await open()
      await select('priority', 'high')
      await evaluate('editorTest.ticket.category={id:3,name:"Outra categoria ativa"}; [...document.querySelectorAll("button")].find(item=>item.textContent==="Atualizar conversa").click()')
      await wait('infoRow("Categoria").textContent==="Outra categoria ativa" && !editorPanel().querySelector("select[name=priority]").disabled')
      assert.equal(await evaluate('editorPanel().querySelector("select[name=priority]").value'), 'high')
      assert.equal(await evaluate('editorPanel().textContent.includes("As informações do chamado foram atualizadas.")'), true)
      await submit()
      await saved()
      assert.deepEqual(await evaluate('editorTest.patches[0].input'), { priority: 'high' })
      assert.equal(await evaluate('infoRow("Categoria").textContent'), 'Outra categoria ativa')
    })
    await t.test('cancelar durante carregamento não deixa formulário reaparecer', async () => {
      await load()
      await evaluate('editorTest.categoryDelay=400')
      await click('Editar informações')
      await click('Cancelar')
      await wait('!editorPanel().querySelector("form")')
      assert.equal(await evaluate('editorTest.patches.length'), 0)
    })
    await t.test('teclado, nomes acessíveis, foco e responsividade de 320 a 1440px', async () => {
      await load()
      await open()
      assert.equal(await evaluate('document.activeElement === editorPanel().querySelector("select[name=category_id]")'), true)
      const ax = await send('Accessibility.getFullAXTree')
      assert.equal(ax.nodes.some(node=>node.role?.value==='combobox' && node.name?.value==='Categoria'), true)
      assert.equal(ax.nodes.some(node=>node.role?.value==='combobox' && node.name?.value==='Prioridade'), true)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.name'), 'priority')
      await select('priority', 'high')
      for (const width of [1440, 1024, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
        assert.equal(await evaluate('[...editorPanel().querySelectorAll("select,button")].every(item=>{const r=item.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth})'), true)
      }
      await evaluate('editorTest.holdDetails=true; editorPanel().querySelector("button[type=submit]").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('typeof editorTest.releaseDetails === "function" && editorPanel().textContent.includes("Atualizando detalhes...") && !editorPanel().querySelector("form")')
      await evaluate('editorTest.releaseDetails()')
      await saved()
      await wait('document.activeElement.matches("button:not(:disabled)") && document.activeElement.textContent === "Editar informações"')
      assert.equal(await evaluate('editorTest.patches.length'), 1)
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
