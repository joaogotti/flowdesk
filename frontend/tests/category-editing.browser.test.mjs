import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// API isolada: nenhuma alteração chega ao backend ou PostgreSQL reais.
function transport() {
  const params = new URLSearchParams(location.search)
  window.categoryEditTest = { boot: crypto.randomUUID(), patches: [], gets: 0, csrfGets: 0, patchStatus: 200, getStatus: 200, csrfStatus: 204, getDelay: 20,
    rows: [{ id: 1, name: 'Hardware', is_active: true, tickets_count: 2 }, { id: 2, name: 'Software', is_active: false, tickets_count: 3 }], fieldErrors: { name: ['Já existe uma categoria com esse nome.'] } }
  window.fetch = async (url, options = {}) => {
    const state = window.categoryEditTest, path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Usuário de teste', email: 'test@example.invalid', role: params.get('role') || 'admin' })
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      document.cookie = 'XSRF-TOKEN=category-edit-test'
      return state.csrfStatus === 204 ? new Response(null, { status: 204 }) : json({}, state.csrfStatus)
    }
    if (/^\/api\/admin\/categories\/\d+$/.test(path) && options.method === 'PATCH') {
      const id = Number(path.split('/').at(-1)), payload = JSON.parse(options.body)
      state.patches.push({ id, payload, method: options.method, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, 200))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus !== 200) return state.patchStatus === 204 ? new Response(null, { status: 204 }) : json({ errors: state.fieldErrors }, state.patchStatus)
      state.rows = state.rows.map(row => row.id === id ? { ...row, name: payload.name } : row).sort((a, b) => a.name.localeCompare(b.name))
      return json({ data: state.rows.find(row => row.id === id) })
    }
    if (path === '/api/admin/categories' && options.method === 'GET') {
      state.gets++
      await new Promise(resolve => setTimeout(resolve, state.getDelay))
      if (state.getStatus === 'offline') throw TypeError('Offline')
      return json({ data: state.rows }, state.getStatus)
    }
    throw Error(`Requisição inesperada: ${options.method} ${path}`)
  }
}

test('edição administrativa de categorias no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (role = 'admin') => {
    const boot = await evaluate('window.categoryEditTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}#/categorias` })
    await wait(`window.categoryEditTest?.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
    if (role === 'admin') await wait('document.querySelectorAll("tbody tr").length===2')
    else await wait('document.querySelector("h1")?.textContent==="Acesso não permitido"')
  }
  const open = async (index = 0) => { await evaluate(`document.querySelectorAll('tbody button[aria-label^=Editar]')[${index}].click()`); await wait('document.activeElement?.id==="category-edit-name"') }
  const name = value => evaluate(`(()=>{const input=document.querySelector('#category-edit-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  try {
    await t.test('preenche nome, identifica categoria e cancelar restaura o botão correspondente', async () => {
      await load(); await open(1)
      assert.equal(await evaluate('document.querySelector("input").value'), 'Software')
      assert.match(await evaluate('document.querySelector("#category-edit-description").textContent'), /Software/)
      assert.equal(await evaluate('document.querySelectorAll("form [name]").length'), 1)
      assert.equal(await evaluate('document.querySelector("form [name]").name'), 'name')
      assert.equal(await evaluate('[...document.querySelectorAll("main button")].find(b=>b.textContent==="Nova categoria").disabled'), true)
      await name('Rascunho')
      await evaluate('[...document.querySelectorAll("form button")].find(b=>b.textContent==="Cancelar").click()')
      await wait('!document.querySelector("form") && document.activeElement?.getAttribute("aria-label")==="Editar categoria Software"')
      assert.deepEqual(await evaluate('[categoryEditTest.patches.length,categoryEditTest.csrfGets]'), [0, 0])
    })
    await t.test('Escape cancela, preserva os dados e restaura foco por teclado', async () => {
      await load(); await open(); await name('Rascunho')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await wait('!document.querySelector("form") && document.activeElement?.getAttribute("aria-label")==="Editar categoria Hardware"')
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Hardware')
    })
    await t.test('nome atual, espaços e reversão não enviam PATCH nem CSRF', async () => {
      await load(); await open()
      for (const value of ['Hardware', '  Hardware  ', 'Hardware']) {
        await name(value)
        assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true)
        await submit()
      }
      assert.deepEqual(await evaluate('[categoryEditTest.patches.length,categoryEditTest.csrfGets]'), [0, 0])
    })
    for (const index of [0, 1]) await t.test(`categoria ${index ? 'inativa' : 'ativa'}: PATCH e GET preservam identidade, situação e contagem`, async () => {
      await load(); await open(index); await name(' \tEquipamentos\n ')
      await evaluate('categoryEditTest.getDelay=700'); await submit()
      await wait('!document.querySelector("form")')
      assert.match(await evaluate('document.querySelector("main").textContent'), /Categoria alterada com sucesso/)
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 0)
      await wait('document.querySelectorAll("tbody tr").length===2 && document.activeElement?.getAttribute("aria-label")==="Editar categoria Equipamentos"')
      assert.deepEqual(await evaluate('categoryEditTest.patches'), [{ id: index + 1, payload: { name: 'Equipamentos' }, method: 'PATCH', credentials: 'include', csrf: 'category-edit-test' }])
      assert.deepEqual(await evaluate('categoryEditTest.rows.find(r=>r.name==="Equipamentos")'), { id: index + 1, name: 'Equipamentos', is_active: index === 0, tickets_count: index ? 3 : 2 })
      assert.equal(await evaluate('categoryEditTest.gets'), 2)
    })
    await t.test('alteração apenas de caixa é permitida', async () => {
      await load(); await open(); await name('HARDWARE'); await submit()
      await wait('!document.querySelector("form") && document.querySelectorAll("tbody tr").length===2')
      assert.equal(await evaluate('categoryEditTest.patches[0].payload.name'), 'HARDWARE')
    })
    await t.test('nome vazio, espaços, longo e nulo exibem validação local sem rede', async () => {
      await load(); await open()
      for (const value of ['', '  ', 'a'.repeat(101), 'a\0b']) {
        await name(value); await submit(); await wait('!!document.querySelector("#category-name-error")')
        assert.equal(await evaluate('document.querySelector("input").getAttribute("aria-invalid")'), 'true')
      }
      assert.equal(await evaluate('document.querySelector("input").maxLength'), 100)
      assert.deepEqual(await evaluate('[categoryEditTest.patches.length,categoryEditTest.csrfGets]'), [0, 0])
    })
    await t.test('envios simultâneos e Escape durante salvamento não duplicam PATCH', async () => {
      await load(); await open(); await name('Equipamentos')
      await evaluate('const f=document.querySelector("form");f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));')
      await wait('categoryEditTest.patches.length===1')
      assert.equal(await evaluate('document.querySelector("input").disabled && [...document.querySelectorAll("form button")].every(b=>b.disabled)'), true)
      await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      assert.equal(await evaluate('!!document.querySelector("form")'), true)
      await wait('!document.querySelector("form")')
      assert.equal(await evaluate('categoryEditTest.patches.length'), 1)
    })
    for (const status of [403, 404, 419, 422, 500, 201, 204, 'offline']) await t.test(`PATCH ${status}: texto preservado, painel aberto e sem GET automático`, async () => {
      await load(); await open(); await name('Software')
      await evaluate(`categoryEditTest.patchStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("input").disabled')
      assert.equal(await evaluate('document.querySelector("input").value'), 'Software')
      assert.equal(await evaluate('categoryEditTest.gets'), 1)
      assert.equal(await evaluate('categoryEditTest.patches.length'), 1)
      assert.match(await evaluate('document.querySelector("form").textContent'), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /Já existe uma categoria/ : /Não foi possível confirmar/)
    })
    await t.test('422 mantém mensagem associada ao campo e permite correção explícita', async () => {
      await load(); await open(); await name('Software')
      await evaluate('categoryEditTest.patchStatus=422'); await submit(); await wait('!!document.querySelector("#category-name-error")')
      assert.match(await evaluate('document.querySelector("input").getAttribute("aria-describedby")'), /category-name-error/)
      await name('Corrigida'); await evaluate('categoryEditTest.patchStatus=200'); await submit()
      await wait('!document.querySelector("form")'); assert.equal(await evaluate('categoryEditTest.patches.length'), 2)
    })
    for (const status of [403, 419, 503, 'offline']) await t.test(`PATCH salvo e GET ${status}: confirmação mantida e retry só de GET`, async () => {
      await load(); await open(); await name('Equipamentos')
      await evaluate(`categoryEditTest.getStatus=${JSON.stringify(status)}`); await submit()
      await wait('!document.querySelector("form") && !!document.querySelector("section[aria-labelledby=categories-title] [role=alert]")')
      assert.match(await evaluate('document.querySelector("main").textContent'), /Categoria alterada com sucesso/)
      await evaluate('categoryEditTest.getStatus=200;document.querySelector("section[aria-labelledby=categories-title] button").click()')
      await wait('document.querySelectorAll("tbody tr").length===2')
      assert.equal(await evaluate('categoryEditTest.patches.length'), 1)
      assert.equal(await evaluate('categoryEditTest.gets'), 3)
    })
    for (const status of [419, 'offline']) await t.test(`CSRF ${status}: não envia PATCH`, async () => {
      await load(); await open(); await name('Equipamentos')
      await evaluate(`categoryEditTest.csrfStatus=${JSON.stringify(status)}`); await submit(); await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('categoryEditTest.patches.length'), 0)
    })
    for (const role of ['technician', 'requester']) await t.test(`${role}: sem acesso à página ou ao editor`, async () => {
      await load(role)
      assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Acesso não permitido')
      assert.equal(await evaluate('document.querySelectorAll("form,main button").length'), 0)
      assert.equal(await evaluate('categoryEditTest.gets'), 0)
    })
    await t.test('teclado, foco visível e painel responsivo', async () => {
      await load()
      await evaluate('document.querySelector("tbody button").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('document.activeElement?.id==="category-edit-name"')
      assert.equal(await evaluate('document.querySelector("label").htmlFor'), 'category-edit-name')
      await name('Equipamentos')
      for (const width of [320, 768, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form button")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
