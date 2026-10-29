import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Toda a API está isolada. Nenhuma categoria é criada no banco real.
function transport() {
  const params = new URLSearchParams(location.search)
  window.categoryCreateTest = { boot: crypto.randomUUID(), posts: [], gets: 0, csrfGets: 0, postStatus: 201, csrfStatus: 204, getStatus: 200, getDelay: 20,
    rows: [{ id: 1, name: 'Hardware', is_active: true, tickets_count: 2 }, { id: 2, name: 'Software', is_active: false, tickets_count: 0 }], fieldErrors: { name: ['Já existe uma categoria com esse nome.'] } }
  window.fetch = async (url, options = {}) => {
    const state = window.categoryCreateTest, path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Usuário de teste', email: 'test@example.invalid', role: params.get('role') || 'admin' })
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      document.cookie = 'XSRF-TOKEN=category-create-test'
      return state.csrfStatus === 204 ? new Response(null, { status: 204 }) : json({}, state.csrfStatus)
    }
    if (path === '/api/admin/categories' && options.method === 'POST') {
      const payload = JSON.parse(options.body)
      state.posts.push({ payload, method: options.method, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, 200))
      if (state.postStatus === 'offline') throw TypeError('Offline')
      if (state.postStatus !== 201) return state.postStatus === 204 ? new Response(null, { status: 204 }) : json({ message: 'Verifique os dados.', errors: state.fieldErrors }, state.postStatus)
      const row = { id: 7, name: payload.name, is_active: true, tickets_count: 0 }
      state.rows = [row, ...state.rows]
      return json({ data: row }, 201)
    }
    if (path === '/api/admin/categories') {
      state.gets++
      await new Promise(resolve => setTimeout(resolve, state.getDelay))
      if (state.getStatus === 'offline') throw TypeError('Offline')
      return json({ data: state.rows }, state.getStatus)
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('cadastro administrativo de categorias no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (role = 'admin') => {
    const boot = await evaluate('window.categoryCreateTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?role=${role}&test=${crypto.randomUUID()}#/categorias` })
    await wait(`window.categoryCreateTest?.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
    if (role === 'admin') await wait('document.querySelectorAll("tbody tr").length===2')
    else await wait('document.querySelector("h1")?.textContent==="Acesso não permitido"')
  }
  const open = async () => { await evaluate('[...document.querySelectorAll("main button")].find(b=>b.textContent==="Nova categoria").click()'); await wait('document.activeElement?.id==="category-create-name"') }
  const name = value => evaluate(`(()=>{const input=document.querySelector('#category-create-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const closed = () => wait('!document.querySelector("#category-create-panel") && document.activeElement?.textContent==="Nova categoria"')
  try {
    await t.test('abre com foco, cancelar e Escape restauram foco sem requisições de escrita', async () => {
      await load(); await open(); await name('Rascunho')
      await evaluate('[...document.querySelectorAll("form button")].find(b=>b.textContent==="Cancelar").click()'); await closed()
      await open(); assert.equal(await evaluate('document.querySelector("input").value'), '')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await closed()
      assert.deepEqual(await evaluate('[categoryCreateTest.posts.length,categoryCreateTest.csrfGets]'), [0, 0])
    })
    await t.test('obrigatório, espaços, limite e mensagem associada ao campo', async () => {
      await load(); await open()
      for (const value of ['', '   ', 'a'.repeat(101)]) {
        await name(value); await submit(); await wait('!!document.querySelector("#category-name-error")')
        assert.equal(await evaluate('document.querySelector("input").getAttribute("aria-invalid")'), 'true')
        assert.equal(await evaluate('document.activeElement.id'), 'category-create-name')
      }
      assert.equal(await evaluate('document.querySelector("input").maxLength'), 100)
      assert.equal(await evaluate('document.querySelector("input").required'), true)
      assert.deepEqual(await evaluate('[categoryCreateTest.posts.length,categoryCreateTest.csrfGets]'), [0, 0])
    })
    await t.test('envio válido normaliza, confirma 201 e consulta lista sem inclusão otimista', async () => {
      await load(); await open(); await name(' \tPeriféricos\n ')
      await evaluate('categoryCreateTest.getDelay=800'); await submit()
      await wait('!!document.querySelector("p[role=status]")?.textContent.includes("Categoria criada")')
      await closed()
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 0)
      await wait('document.querySelectorAll("tbody tr").length===3')
      assert.deepEqual(await evaluate('categoryCreateTest.posts'), [{ payload: { name: 'Periféricos' }, method: 'POST', credentials: 'include', csrf: 'category-create-test' }])
      assert.equal(await evaluate('categoryCreateTest.gets'), 2)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("tbody th")].map(n=>n.textContent)'), ['Periféricos', 'Hardware', 'Software'])
    })
    await t.test('bloqueia submits simultâneos, edição, Cancelar e Escape durante envio', async () => {
      await load(); await open(); await name('Rede')
      await evaluate('const f=document.querySelector("form");f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));')
      await wait('categoryCreateTest.posts.length===1')
      assert.equal(await evaluate('document.querySelector("input").disabled && [...document.querySelectorAll("form button")].every(b=>b.disabled)'), true)
      await evaluate('document.querySelector("form").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
      assert.equal(await evaluate('!!document.querySelector("form")'), true)
      await closed(); assert.equal(await evaluate('categoryCreateTest.posts.length'), 1)
      assert.equal(await evaluate('categoryCreateTest.csrfGets'), 1)
    })
    for (const status of [401, 403, 419, 422, 500, 200, 204, 'offline']) await t.test(`POST ${status}: preserva conteúdo e formulário sem sucesso falso`, async () => {
      await load(); await open(); await name('Hardware')
      await evaluate(`categoryCreateTest.postStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("input").disabled')
      assert.equal(await evaluate('document.querySelector("input").value'), 'Hardware')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 2)
      assert.equal(await evaluate('categoryCreateTest.gets'), 1)
      assert.match(await evaluate('document.querySelector("form").textContent'), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 422 ? /Já existe uma categoria/ : /Não foi possível confirmar/)
      if (status === 422) assert.match(await evaluate('document.querySelector("input").getAttribute("aria-describedby")'), /category-name-error/)
    })
    await t.test('outros erros de validação e nova tentativa explícita preservam campo', async () => {
      await load(); await open(); await name('Teste')
      await evaluate('categoryCreateTest.postStatus=422;categoryCreateTest.fieldErrors={name:["Nome inválido no teste."]}')
      await submit(); await wait('!!document.querySelector("#category-name-error")')
      assert.equal(await evaluate('document.querySelector("#category-name-error").textContent'), 'Nome inválido no teste.')
      await name('Corrigida'); await evaluate('categoryCreateTest.postStatus=201'); await submit(); await closed()
      assert.equal(await evaluate('categoryCreateTest.posts.length'), 2)
    })
    for (const status of [419, 'offline']) await t.test(`CSRF ${status} impede POST`, async () => {
      await load(); await open(); await name('Rede')
      await evaluate(`categoryCreateTest.csrfStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('categoryCreateTest.posts.length'), 0)
      assert.equal(await evaluate('document.querySelector("input").value'), 'Rede')
    })
    await t.test('POST confirmado e GET falho: mantém confirmação, retry somente GET', async () => {
      await load(); await open(); await name('Rede')
      await evaluate('categoryCreateTest.getStatus=503'); await submit(); await closed()
      await wait('!!document.querySelector("section[aria-labelledby=categories-title] [role=alert]")')
      assert.match(await evaluate('document.querySelector("main").textContent'), /Categoria criada com sucesso/)
      await evaluate('categoryCreateTest.getStatus=200;document.querySelector("section[aria-labelledby=categories-title] button").click()')
      await wait('document.querySelectorAll("tbody tr").length===3')
      assert.equal(await evaluate('categoryCreateTest.posts.length'), 1)
      assert.equal(await evaluate('categoryCreateTest.gets'), 3)
    })
    for (const role of ['technician', 'requester']) await t.test(`${role}: nenhum formulário ou cadastro`, async () => {
      await load(role)
      assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Acesso não permitido')
      assert.equal(await evaluate('document.querySelectorAll("form,main button").length'), 0)
      assert.deepEqual(await evaluate('[categoryCreateTest.gets,categoryCreateTest.posts.length,categoryCreateTest.csrfGets]'), [0, 0, 0])
    })
    await t.test('teclado, campo acessível, contador e responsividade', async () => {
      await load(); await open(); await name('Rede')
      assert.equal(await evaluate('document.querySelector("label").htmlFor'), 'category-create-name')
      assert.match(await evaluate('document.querySelector("#category-name-count").textContent'), /4\/100/)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.textContent'), 'Cancelar')
      for (const width of [320, 768, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form input,form button")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
