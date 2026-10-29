import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Transporte isolado antes do carregamento: nunca acessa a API real.
function transport() {
  window.statusTest = { boot: crypto.randomUUID(), patches: [], gets: 0, csrfGets: 0, patchStatus: 200, getStatus: 200, csrfStatus: 204,
    rows: [{ id: 1, name: 'Hardware', is_active: true, tickets_count: 2 }, { id: 2, name: 'Software', is_active: false, tickets_count: 3 }] }
  window.fetch = async (url, options = {}) => {
    const state = window.statusTest, path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Admin', email: 'test@example.invalid', role: 'admin' })
    if (path === '/sanctum/csrf-cookie') {
      state.csrfGets++
      if (state.csrfStatus === 'offline') throw TypeError('Offline')
      document.cookie = 'XSRF-TOKEN=status-test'
      return state.csrfStatus === 204 ? new Response(null, { status: 204 }) : json({}, state.csrfStatus)
    }
    if (/^\/api\/admin\/categories\/\d+\/status$/.test(path) && options.method === 'PATCH') {
      const id = Number(path.split('/').at(-2)), payload = JSON.parse(options.body)
      state.patches.push({ id, payload, credentials: options.credentials, csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, 350))
      if (state.patchStatus === 'offline') throw TypeError('Offline')
      if (state.patchStatus !== 200) return state.patchStatus === 204 ? new Response(null, { status: 204 }) : json({ errors: { is_active: ['Situação inválida.'] } }, state.patchStatus)
      state.rows = state.rows.map(row => row.id === id ? { ...row, is_active: payload.is_active } : row)
      return json({ data: state.rows.find(row => row.id === id) })
    }
    if (path === '/api/admin/categories' && options.method === 'GET') {
      state.gets++
      await new Promise(resolve => setTimeout(resolve, 100))
      if (state.getStatus === 'offline') throw TypeError('Offline')
      return json({ data: state.rows }, state.getStatus)
    }
    throw Error(`Requisição inesperada: ${options.method} ${path}`)
  }
}

test('situação administrativa de categorias no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async () => {
    const boot = await evaluate('window.statusTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?test=${crypto.randomUUID()}#/categorias` })
    await wait(`window.statusTest?.boot !== ${JSON.stringify(boot)} && document.querySelectorAll('tbody tr').length===2`)
  }
  const open = async (index = 0) => {
    await evaluate(`document.querySelectorAll('tbody button[aria-label^=Desativar],tbody button[aria-label^=Ativar]')[${index}].click()`)
    await wait('document.activeElement?.textContent==="Cancelar"')
  }
  const submit = () => evaluate('document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
  const key = async (key, code) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  }
  try {
    await t.test('ações, consequências, cancelar e Escape restauram foco sem rede', async () => {
      await load()
      assert.deepEqual(await evaluate('[...document.querySelectorAll("tbody button")].map(b=>b.textContent)'), ['Editar', 'Desativar', 'Editar', 'Ativar'])
      await open()
      assert.match(await evaluate('document.querySelector("#category-status-description").textContent'), /Hardware.*novos chamados.*existentes continuarão vinculados.*reativada/s)
      await key('Escape', 27)
      await wait('!document.querySelector("form") && document.activeElement?.getAttribute("aria-label")==="Desativar categoria Hardware"')
      await open(1)
      assert.match(await evaluate('document.querySelector("#category-status-description").textContent'), /Software/)
      await evaluate('document.activeElement.click()')
      await wait('!document.querySelector("form") && document.activeElement?.getAttribute("aria-label")==="Ativar categoria Software"')
      assert.deepEqual(await evaluate('[statusTest.patches.length,statusTest.csrfGets]'), [0, 0])
    })
    for (const index of [0, 1]) await t.test(`${index ? 'ativação' : 'desativação'}: booleano exclusivo, carregamento, duplicidade e GET`, async () => {
      await load(); await open(index)
      await evaluate('const f=document.querySelector("form");for(let i=0;i<3;i++)f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
      await wait('statusTest.patches.length===1')
      assert.equal(await evaluate('[...document.querySelectorAll("form button")].every(b=>b.disabled)'), true)
      assert.equal(await evaluate(`document.querySelectorAll('tbody tr')[${index}].children[1].textContent`), index ? 'Inativa' : 'Ativa')
      await key('Escape', 27)
      assert.equal(await evaluate('!!document.querySelector("form")'), true)
      await wait(`!document.querySelector('form') && document.querySelectorAll('tbody tr').length===2 && document.activeElement?.getAttribute('aria-label')===${JSON.stringify(index ? 'Desativar categoria Software' : 'Ativar categoria Hardware')}`)
      assert.deepEqual(await evaluate('statusTest.patches'), [{ id: index + 1, payload: { is_active: index === 1 }, credentials: 'include', csrf: 'status-test' }])
      assert.equal(await evaluate('statusTest.gets'), 2)
      assert.match(await evaluate('document.querySelector("main").textContent'), index ? /Categoria ativada com sucesso/ : /Categoria desativada com sucesso/)
      assert.deepEqual(await evaluate(`statusTest.rows[${index}]`), { id: index + 1, name: index ? 'Software' : 'Hardware', is_active: index === 1, tickets_count: index ? 3 : 2 })
    })
    for (const status of [401, 403, 404, 419, 422, 500, 201, 204, 'offline']) await t.test(`PATCH ${status}: erro sem alteração visual ou GET`, async () => {
      await load(); await open(); await evaluate(`statusTest.patchStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]") && !document.querySelector("form button").disabled')
      assert.match(await evaluate('document.querySelector("form [role=alert]").textContent'), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /Situação inválida/ : /Não foi possível confirmar/)
      assert.equal(await evaluate('document.querySelector("tbody tr").children[1].textContent'), 'Ativa')
      assert.deepEqual(await evaluate('[statusTest.patches.length,statusTest.gets]'), [1, 1])
    })
    for (const status of [401, 403, 404, 419, 422, 'offline']) await t.test(`GET ${status} após PATCH: retry só consulta e restaura foco`, async () => {
      await load(); await open(); await evaluate(`statusTest.getStatus=${JSON.stringify(status)}`); await submit()
      await wait('!document.querySelector("form") && document.activeElement?.textContent==="Tentar novamente"')
      assert.match(await evaluate('document.querySelector("main").textContent'), /Categoria desativada com sucesso/)
      await evaluate('statusTest.getStatus=200'); await key('Enter', 13)
      await wait('document.activeElement?.getAttribute("aria-label")==="Ativar categoria Hardware"')
      assert.deepEqual(await evaluate('[statusTest.patches.length,statusTest.gets]'), [1, 3])
    })
    for (const status of [419, 'offline']) await t.test(`CSRF ${status} impede PATCH`, async () => {
      await load(); await open(); await evaluate(`statusTest.csrfStatus=${JSON.stringify(status)}`); await submit()
      await wait('!!document.querySelector("form [role=alert]")')
      assert.equal(await evaluate('statusTest.patches.length'), 0)
    })
    await t.test('teclado, foco inicial, Tab e responsividade', async () => {
      await load(); await evaluate('document.querySelector("tbody button[aria-label^=Desativar]").focus()'); await key('Enter', 13)
      await wait('document.activeElement?.textContent==="Cancelar"')
      await key('Tab', 9)
      assert.equal(await evaluate('document.activeElement?.textContent'), 'Desativar categoria')
      for (const width of [320, 768, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("form button")].every(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
