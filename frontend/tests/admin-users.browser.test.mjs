import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Todas as consultas são isoladas antes de a aplicação iniciar. Nunca acessa dados reais.
function transport() {
  const params = new URLSearchParams(location.search), role = params.get('role') || 'admin'
  const roles = ['admin', 'technician', 'requester']
  const names = ['Ana Administradora', 'Bruno Técnico', 'Carla Solicitante']
  window.userTest = { boot: crypto.randomUUID(), requests: [], aborts: 0, delay: Number(params.get('delay') || 20),
    ignoreAbort: params.has('ignoreAbort'), status: params.get('status') || '200',
    rows: params.has('empty') ? [] : Array.from({ length: 37 }, (_, i) => ({ id: i + 1,
      name: params.has('long') && i === 0 ? 'NomeSemEspacos'.repeat(40) : names[i] || `Usuário ${String(i).padStart(2, '0')}`,
      email: params.has('long') && i === 0 ? `${'email'.repeat(50)}@example.invalid` : `conta${i + 1}@example.invalid`,
      role: roles[i % 3], disabled_at: i % 4 === 1 ? '2030-01-01T00:00:00Z' : null,
      created_at: i === 2 ? null : '2026-10-22T00:43:42Z', password: 'private-marker', remember_token: 'private-marker' })) }
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname, state = window.userTest
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Usuário de teste', email: 'test@example.invalid', role }, Number(params.get('userStatus') || 200))
    if (path === '/api/admin/users') {
      const query = Object.fromEntries(new URL(url).searchParams)
      state.requests.push({ query, method: options.method, credentials: options.credentials, body: options.body ?? null })
      const status = state.status
      let rows = structuredClone(state.rows)
      if (query.search) { const s = query.search.toLocaleLowerCase(); rows = rows.filter(r=>r.name.toLocaleLowerCase().includes(s)||r.email.toLocaleLowerCase().includes(s)) }
      if (query.role) rows = rows.filter(r=>r.role===query.role)
      if (query.status) rows = rows.filter(r=>(r.disabled_at===null)===(query.status==='active'))
      const total = rows.length, page = Number(query.page || 1), perPage = Number(query.per_page || 15)
      const last = Math.max(1, Math.ceil(total / perPage)), start = (page - 1) * perPage
      rows = rows.slice(start, start + perPage)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, state.delay)
        options.signal?.addEventListener('abort', () => { state.aborts++; if (!state.ignoreAbort) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) } }, { once: true })
      })
      if (status === 'offline') throw TypeError('Offline')
      if (status === 'invalid') return json({ data: [{ id: 1 }] })
      const link = p => `http://flowdesk.test/api/admin/users?page=${p}`
      return json({ data: rows, current_page: page, last_page: last, per_page: perPage, total,
        from: rows.length ? start + 1 : null, to: rows.length ? start + rows.length : null,
        first_page_url: link(1), last_page_url: link(last), next_page_url: page < last ? link(page + 1) : null,
        prev_page_url: page > 1 ? link(page - 1) : null, path: 'http://flowdesk.test/api/admin/users', links: [],
        errors: status === '422' ? { search: ['Verifique a pesquisa informada.'] } : undefined }, Number(status))
    }
    if (path === '/api/admin/categories') return json({ data: [] })
    if (path.startsWith('/api/dashboard/')) return json({ data: path.endsWith('/stats') ? { total: 0, open: 0, in_progress: 0, waiting_requester: 0, resolved: 0, closed: 0, cancelled: 0, unassigned: 0 } : path.endsWith('/sla') ? { on_track: 0, at_risk: 0, overdue: 0 } : [] })
    throw Error(`Requisição inesperada: ${options.method} ${path}`)
  }
}

test('listagem administrativa de usuários no navegador', { skip: !browserExecutable, timeout: 120000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const load = async (query = '', route = '#/usuarios') => {
    const boot = await evaluate('window.userTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?${query}&test=${crypto.randomUUID()}${route}` })
    await wait(`!!window.userTest && window.userTest.boot !== ${JSON.stringify(boot)} && !!document.querySelector('h1')`)
  }
  const ready = () => wait('document.querySelector("section[aria-labelledby=users-title]")?.getAttribute("aria-busy")==="false"')
  const input = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${selector === '#user-search' ? 'HTMLInputElement' : 'HTMLSelectElement'}.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(${JSON.stringify(selector === '#user-search' ? 'input' : 'change')},{bubbles:true}));})()`)
  const button = label => evaluate(`[...document.querySelectorAll('main button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  try {
    await t.test('admin: navegação próxima de Categorias, contrato, traduções e ação de edição', async () => {
      await load(); await ready()
      assert.equal(await evaluate('document.title'), 'Usuários | Flowdesk')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#workspace-navigation a")].slice(-4).map(a=>a.textContent.trim())'), ['Categorias', 'Usuários', 'Relatórios', 'Configurações'])
      assert.equal(await evaluate('document.querySelector("nav a[aria-current=page]").getAttribute("href")'), '#/usuarios')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 15)
      assert.deepEqual(await evaluate('[...document.querySelector("tbody tr").children].map(n=>n.textContent)'), ['Ana Administradora', 'conta1@example.invalid', 'Administrador', 'Ativo', '21/10/2026, 21:43', 'Editar'])
      assert.equal(await evaluate('document.querySelectorAll("tbody tr")[1].children[3].textContent'), 'Desativado')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr")[2].children[4].textContent'), 'Não informada')
      assert.deepEqual(await evaluate('userTest.requests'), [{ query: { page: '1', per_page: '15' }, method: 'GET', credentials: 'include', body: null }])
      assert.equal(await evaluate('document.querySelectorAll("tbody button[aria-label^=Editar]").length'), 15)
      assert.equal(await evaluate('document.querySelector("main").textContent.includes("private-marker")'), false)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("thead th")].map(n=>n.textContent)'), ['Nome', 'E-mail', 'Perfil', 'Situação', 'Data de cadastro', 'Ações'])
    })
    for (const role of ['technician', 'requester']) await t.test(`${role}: sem item e sem GET ao acessar diretamente`, async () => {
      await load(`role=${role}`)
      await wait('document.querySelector("h1")?.textContent==="Acesso não permitido"')
      assert.equal(await evaluate('[...document.querySelectorAll("nav a")].some(a=>a.getAttribute("href")==="#/usuarios")'), false)
      assert.equal(await evaluate('userTest.requests.length'), 0)
      assert.equal(await evaluate('!!document.querySelector("#user-search")'), false)
    })
    for (const status of [401, 403, 419]) await t.test(`sessão inicial ${status}: não consulta usuários`, async () => {
      await load(`userStatus=${status}`)
      await wait('document.querySelector("h1")?.textContent==="Entrar no Flowdesk"')
      assert.equal(await evaluate('userTest.requests.length'), 0)
    })
    await t.test('paginação no servidor preserva total, limita linhas e filtros retornam à primeira página', async () => {
      await load(); await ready(); await button('Próxima'); await wait('userTest.requests.length===2'); await ready()
      assert.equal(await evaluate('userTest.requests.at(-1).query.page'), '2')
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Usuário 15')
      await input('#user-role', 'technician'); await wait('userTest.requests.length===3'); await ready()
      assert.equal(await evaluate('userTest.requests.at(-1).query.page'), '1')
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 12)
      assert.equal(await evaluate('[...document.querySelectorAll("tbody tr")].every(r=>r.children[2].textContent==="Técnico")'), true)
      await input('#user-status', 'disabled'); await wait('userTest.requests.length===4'); await ready()
      assert.equal(await evaluate('userTest.requests.at(-1).query.status'), 'disabled')
      assert.equal(await evaluate('[...document.querySelectorAll("tbody tr")].every(r=>r.children[3].textContent==="Desativado")'), true)
      await button('Limpar filtros'); await wait('userTest.requests.length===5'); await ready()
      await button('Próxima'); await ready(); await button('Próxima'); await ready()
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 7)
      assert.equal(await evaluate('[...document.querySelectorAll("main button")].find(b=>b.textContent==="Próxima").disabled'), true)
      await button('Anterior'); await ready()
      assert.equal(await evaluate('userTest.requests.at(-1).query.page'), '2')
    })
    await t.test('pesquisa por nome/e-mail com debounce envia apenas o valor final e reinicia página', async () => {
      await load(); await ready(); await button('Próxima'); await ready()
      const before = await evaluate('userTest.requests.length')
      await input('#user-search', 'A'); await input('#user-search', 'An'); await input('#user-search', 'Ana')
      assert.equal(await evaluate('userTest.requests.length'), before)
      await wait(`userTest.requests.length===${before + 1}`); await ready()
      assert.deepEqual(await evaluate('userTest.requests.at(-1).query'), { page: '1', per_page: '15', search: 'Ana' })
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 1)
      await input('#user-search', 'conta2@'); await wait('userTest.requests.at(-1).query.search==="conta2@"'); await ready()
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Bruno Técnico')
      await input('#user-role', 'technician'); await ready(); await input('#user-status', 'disabled'); await ready()
      assert.deepEqual(await evaluate('userTest.requests.at(-1).query'), { page: '1', per_page: '15', search: 'conta2@', role: 'technician', status: 'disabled' })
    })
    await t.test('carregamento, vazio inicial e ausência de resultados filtrados', async () => {
      await load('delay=900'); await wait('userTest.requests.length===1')
      assert.match(await evaluate('document.querySelector("main").textContent'), /Carregando usuários/)
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 0)
      await ready(); await input('#user-search', 'inexistente'); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Nenhum usuário encontrado/)
      await load('empty'); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Nenhum usuário cadastrado/)
    })
    for (const status of ['403', '419', '422', '500', 'offline', 'invalid']) await t.test(`GET ${status}: erro sem dados anteriores e nova tentativa`, async () => {
      await load(`status=${status}`); await ready()
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 0)
      assert.match(await evaluate('document.querySelector("main [role=alert]").textContent'), ['401', '419'].includes(status) ? /sessão expirou/ : status === '403' ? /permissão/ : status === '422' ? /Verifique a pesquisa/ : /Não foi possível carregar/)
      await evaluate('userTest.status="200"'); await button('Tentar novamente'); await ready()
      assert.equal(await evaluate('userTest.requests.length'), 2)
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 15)
    })
    await t.test('cancelamento ao sair e resposta antiga ignorada mesmo com transporte sem abort', async () => {
      await load('delay=900&ignoreAbort'); await wait('userTest.requests.length===1')
      await evaluate('location.hash="#/categorias"'); await wait('document.querySelector("h1")?.textContent==="Categorias"')
      assert.equal(await evaluate('userTest.aborts'), 1)
      await evaluate('userTest.delay=10;userTest.rows=[{id:99,name:"Resposta atual",email:"atual@example.invalid",role:"admin",disabled_at:null,created_at:null}];location.hash="#/usuarios"')
      await wait('document.querySelector("tbody th")?.textContent==="Resposta atual"')
      await evaluate('new Promise(r=>setTimeout(r,1000))')
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Resposta atual')
    })
    await t.test('mudança de pesquisa aborta GET anterior e não aplica resposta obsoleta', async () => {
      await load('ignoreAbort'); await ready()
      await evaluate('userTest.delay=1000'); await input('#user-search', 'Bruno'); await wait('userTest.requests.length===2')
      await evaluate('userTest.delay=10'); await input('#user-search', 'Ana'); await wait('userTest.requests.length===3'); await ready()
      await evaluate('new Promise(r=>setTimeout(r,1100))')
      assert.equal(await evaluate('document.querySelector("tbody th").textContent'), 'Ana Administradora')
      assert.ok(await evaluate('userTest.aborts>=1'))
    })
    await t.test('página esvaziada permite voltar à primeira sem filtrar no navegador', async () => {
      await load(); await ready(); await button('Próxima'); await ready()
      await evaluate('userTest.rows=userTest.rows.slice(0,2)'); await button('Atualizar lista'); await ready()
      assert.match(await evaluate('document.querySelector("main").textContent'), /Não há usuários nesta página/)
      await button('Voltar à primeira página'); await ready()
      assert.equal(await evaluate('document.querySelectorAll("tbody tr").length'), 2)
    })
    await t.test('navegação por teclado, rótulos, tabela e navegação mobile responsivas', async () => {
      await load('long', '#/categorias'); await wait('document.querySelector("h1")?.textContent==="Categorias"')
      await evaluate('[...document.querySelectorAll("nav a")].find(a=>a.getAttribute("href")==="#/usuarios").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await wait('!!document.querySelector("#user-search")'); await ready()
      assert.equal(await evaluate('document.querySelectorAll("thead th[scope=col]").length'), 6)
      assert.equal(await evaluate('document.querySelectorAll("tbody th[scope=row]").length'), 15)
      for (const width of [320, 375, 768, 1024, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
        assert.equal(await evaluate('[...document.querySelectorAll("main input,main select")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&!!document.querySelector(`label[for="${n.id}"]`)})'), true)
        assert.equal(await evaluate('document.querySelector("[role=region]").tabIndex'), 0)
        if (width===320) {
          await evaluate('document.querySelector("button[aria-controls=workspace-navigation]").click()')
          assert.equal(await evaluate('document.querySelector("button[aria-controls=workspace-navigation]").getAttribute("aria-expanded")'), 'true')
          await evaluate('[...document.querySelectorAll("nav a")].find(a=>a.getAttribute("href")==="#/usuarios").click()')
          assert.equal(await evaluate('document.querySelector("button[aria-controls=workspace-navigation]").getAttribute("aria-expanded")'), 'false')
        }
      }
      assert.equal(await evaluate('userTest.requests.every(r=>r.method==="GET"&&r.body===null)'), true)
      await evaluate('document.querySelector("#user-search").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'user-role')
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
