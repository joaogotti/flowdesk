import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

function transport() {
  const params = new URLSearchParams(location.search)
  const date = '2026-10-29T20:00:00Z'
  const role = params.get('role') || 'admin'
  const text = '<img src=x onerror="window.attachmentXss=true">\nTexto seguro: ação.'
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0))
  const make = (id, name, mime, bytes) => ({ id, original_name: name, mime_type: mime, size_bytes: bytes,
    uploaded_by: { id: 9, name: 'Autor do anexo' }, created_at: date, confirmed_at: date })
  const items = [make(1, 'relatório.txt', 'text/plain', new TextEncoder().encode(text).length), make(2, 'captura.png', 'image/png', png.length), make(3, 'manual.pdf', 'application/pdf', 8)]
  const ticket = { id: 8, title: 'Chamado com anexos', description: 'Descrição preservada', priority: 'medium',
    requester: { id: 9, name: 'Solicitante' }, assignee: null, category: { id: 1, name: 'Categoria' },
    status: { id: 1, code: params.get('status') || 'open', name: 'Status do chamado' },
    created_at: date, updated_at: date, first_response_due_at: '2026-10-30T20:00:00Z', resolution_due_at: '2026-10-31T20:00:00Z',
    first_responded_at: null, resolved_at: null, closed_at: null, comments: [], activities: [] }
  const state = window.attachmentTest = { boot: crypto.randomUUID(), posts: [], lists: 0, detailGets: 0, downloads: [], urls: [], revoked: [], saves: [],
    items: params.has('empty') ? [] : items, ticket, listStatus: Number(params.get('listStatus') || 200), detailStatus: Number(params.get('detailStatus') || 200), uploadStatus: 201, downloadStatus: 200,
    code: '', delay: 100, listDelay: 0, downloadDelay: 0, uploadedBytes: {}, uploadedTypes: {} }
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = blob => { const url = create(blob); state.urls.push({ url, type: blob.type, bytes: blob.size }); return url }
  URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url) }
  HTMLAnchorElement.prototype.click = function () { state.saves.push({ name: this.download, url: this.href }) }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    if (path === '/api/user') return json({ id: role === 'requester' ? 9 : 1, name: 'Usuário autenticado', email: 'teste@example.invalid', role })
    if (path === '/sanctum/csrf-cookie') { document.cookie = 'XSRF-TOKEN=attachment-test'; return new Response(null, { status: 204 }) }
    if (path === '/api/tickets/8') { state.detailGets++; return json(ticket, state.detailStatus) }
    if (path === '/api/tickets/8/attachments' && options.method === 'POST') {
      const file = options.body.get('file')
      state.posts.push({ fields: [...options.body.keys()], name: file.name, type: file.type, size: file.size,
        cookies: options.credentials, contentType: options.headers.get('Content-Type'), csrf: options.headers.get('X-XSRF-TOKEN') })
      await new Promise(resolve => setTimeout(resolve, state.delay))
      if (state.uploadStatus === 'offline') throw TypeError('Offline')
      if (state.uploadStatus !== 201) return json({ code: state.code, errors: { file: ['Arquivo inválido informado pelo servidor.'] } }, state.uploadStatus)
      const entry = make(20 + state.posts.length, file.name, file.type || 'text/plain', file.size)
      state.uploadedBytes[entry.id] = await file.arrayBuffer(); state.uploadedTypes[entry.id] = entry.mime_type
      state.items.push(entry)
      ticket.activities.push({ id: entry.id, action: 'attachment_added', actor: { id: 1, name: 'Usuário autenticado' }, created_at: date })
      return json({ data: entry }, 201)
    }
    if (path === '/api/tickets/8/attachments') {
      state.lists++; const snapshot = structuredClone(state.items), responseStatus = state.listStatus
      await new Promise(resolve => setTimeout(resolve, state.listDelay))
      return json({ data: snapshot, code: state.code }, responseStatus)
    }
    const match = path.match(/^\/api\/tickets\/8\/attachments\/(\d+)\/download$/)
    if (match) {
      state.downloads.push(Number(match[1]))
      await new Promise(resolve => setTimeout(resolve, state.downloadDelay))
      if (state.downloadStatus === 'offline') throw TypeError('Offline')
      if (state.downloadStatus !== 200) return json({ code: state.code }, state.downloadStatus)
      const id = Number(match[1]), content = id === 1 ? text : id === 2 ? png : id === 3 ? '%PDF-1.4' : state.uploadedBytes[id]
      const mime = id === 1 ? 'text/plain' : id === 2 ? 'image/png' : id === 3 ? 'application/pdf' : state.uploadedTypes[id]
      return new Response(content, { headers: { 'Content-Type': mime } })
    }
    throw Error('Unexpected mocked request: ' + path)
  }
}

test('anexos no navegador com transporte totalmente simulado', { skip: !browserExecutable, timeout: 180000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const scope = 'document.querySelector("section[aria-labelledby=attachments-title]")'
  const click = label => evaluate(`[...${scope}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  const choose = (name = 'novo.txt', type = 'text/plain', content = 'Arquivo novo') => evaluate(`(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:${JSON.stringify(type)}}));
    const input=document.querySelector('#attachment-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  const action = (label, name) => evaluate(`document.querySelector('button[aria-label=${JSON.stringify(`${label} ${name}`)}]').click()`)
  const load = async query => {
    const boot = await evaluate('window.attachmentTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?${query || ''}&case=${crypto.randomUUID()}#/chamados/8` })
    await wait(`window.attachmentTest?.boot && window.attachmentTest.boot!==${JSON.stringify(boot)}`)
    await wait('document.querySelector("#attachments-title") && !document.body.textContent.includes("Carregando anexos...")')
  }
  try {
    await t.test('posição, metadados, leitura para os três perfis e PDF sem visualização', async () => {
      for (const role of ['requester', 'technician', 'admin']) {
        await load(`role=${role}`)
        assert.equal(await evaluate(`${scope}.previousElementSibling.querySelector('h2').textContent`), 'Descrição do problema')
        assert.equal(await evaluate(`${scope}.nextElementSibling.querySelector('h2').textContent`), 'Conversa')
        assert.equal(await evaluate(`${scope}.querySelectorAll('li').length`), 3)
        assert.match(await evaluate(`${scope}.textContent`), /Autor do anexo/)
        assert.equal(await evaluate(`${scope}.querySelectorAll('time').length`), 3)
        assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Visualizar manual.pdf"]')`), false)
        assert.equal(await evaluate('attachmentTest.posts.length'), 0)
      }
    })
    await t.test('upload único, processamento, CSRF e atualização da lista/histórico sem recarregar', async () => {
      await load('empty')
      const boot = await evaluate('attachmentTest.boot')
      const initialLists = await evaluate('attachmentTest.lists')
      await choose()
      await evaluate('attachmentTest.delay=400')
      await click('Enviar arquivo')
      await wait('attachmentTest.posts.length===1')
      assert.equal(await evaluate('document.querySelector("#attachment-file").disabled'), true)
      await click('Enviando anexo...')
      await wait('document.body.textContent.includes("Anexo enviado com sucesso.") && document.querySelectorAll("section[aria-labelledby=attachments-title] li").length===1')
      assert.equal(await evaluate('attachmentTest.boot'), boot)
      assert.equal(await evaluate('attachmentTest.posts.length'), 1)
      assert.deepEqual(await evaluate('attachmentTest.posts[0]'), { fields: ['file'], name: 'novo.txt', type: 'text/plain', size: 12, cookies: 'include', contentType: null, csrf: 'attachment-test' })
      assert.equal(await evaluate('attachmentTest.lists'), initialLists + 1)
      assert.equal(await evaluate('document.querySelector("#attachment-file").value'), '')
      await wait('document.body.textContent.includes("Anexo adicionado")')
      assert.equal(await evaluate('attachmentTest.ticket.first_responded_at'), null)
      assert.equal(await evaluate('attachmentTest.ticket.status.code'), 'open')
    })
    await t.test('validação local impede arquivo vazio, falsificação, extensão e tamanho excessivo', async () => {
      await load('empty')
      await click('Enviar arquivo')
      await wait('document.querySelector("#attachment-file-error")?.textContent.includes("Selecione")')
      assert.equal(await evaluate('document.activeElement.id'), 'attachment-file')
      for (const [name, type, content] of [['empty.txt','text/plain',''], ['bad.svg','image/svg+xml','x'], ['fake.png','text/plain','x'], ['big.txt','text/plain','x'.repeat(5242881)]]) {
        await choose(name, type, content)
        await click('Enviar arquivo')
        assert.equal(await evaluate('document.querySelector("#attachment-file").getAttribute("aria-invalid")'), 'true')
      }
      assert.equal(await evaluate('attachmentTest.posts.length'), 0)
    })
    await t.test('TXT é texto literal; foco, Escape e retorno ao botão', async () => {
      await load()
      await action('Visualizar', 'relatório.txt')
      await wait('!!document.querySelector("pre[aria-label]")')
      assert.match(await evaluate('document.querySelector("pre").textContent'), /<img src=x onerror=/)
      assert.equal(await evaluate('!!window.attachmentXss'), false)
      assert.equal(await evaluate('document.querySelector("pre img")'), null)
      assert.equal(await evaluate('document.activeElement.id'), 'attachment-preview-title')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await wait('!document.querySelector("#attachment-preview-title")')
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Visualizar relatório.txt')
    })
    await t.test('imagem usa Blob privado e libera URLs ao fechar, trocar e sair do chamado', async () => {
      await load()
      await action('Visualizar', 'captura.png')
      await wait(`document.querySelector('img[alt="Anexo captura.png"]')?.naturalWidth===1`)
      const first = await evaluate('attachmentTest.urls.at(-1).url')
      assert.ok(first.startsWith('blob:'))
      await click('Fechar visualização')
      await wait(`attachmentTest.revoked.includes(${JSON.stringify(first)})`)
      await action('Visualizar', 'captura.png')
      await wait(`!!document.querySelector('img[alt="Anexo captura.png"]')?.src`)
      const second = await evaluate('attachmentTest.urls.at(-1).url')
      await action('Visualizar', 'relatório.txt')
      await wait(`attachmentTest.revoked.includes(${JSON.stringify(second)})`)
      await action('Visualizar', 'captura.png')
      await wait(`!!document.querySelector('img[alt="Anexo captura.png"]')?.src`)
      const third = await evaluate('attachmentTest.urls.at(-1).url')
      await evaluate('location.hash="#/usuarios"')
      await wait(`attachmentTest.revoked.includes(${JSON.stringify(third)})`)
    })
    await t.test('download usa endpoint autenticado, nome original e libera URL temporária', async () => {
      await load()
      await action('Baixar', 'manual.pdf')
      await wait('attachmentTest.saves.length===1')
      assert.equal(await evaluate('attachmentTest.saves[0].name'), 'manual.pdf')
      assert.equal(await evaluate('attachmentTest.saves[0].url.startsWith("blob:")'), true)
      assert.deepEqual(await evaluate('attachmentTest.downloads'), [3])
      await wait('attachmentTest.revoked.includes(attachmentTest.saves[0].url)')
      assert.equal(await evaluate('!!document.querySelector("iframe,embed,object")'), false)
    })
    await t.test('status finais mantêm consulta/download e ocultam envio', async () => {
      for (const status of ['resolved','closed','cancelled']) {
        await load(`status=${status}`)
        assert.equal(await evaluate('!!document.querySelector("#attachment-file")'), false)
        await action('Baixar','manual.pdf')
        await wait('attachmentTest.saves.length===1')
      }
    })
    for (const [status, code, fragment] of [
      [403,'','permissão'],[404,'','não existe'],
      [409,'attachment_limit_reached','25 MiB'],[409,'attachment_reservation_expired','expirou'],[409,'ticket_not_writable','status atual'],
      [413,'','limite'],[419,'','validar sua sessão'],[422,'','Arquivo inválido informado'],[429,'','10 tentativas'],[503,'attachment_unavailable','armazenamento'],['offline','','conexão'],
    ]) await t.test(`erro de envio ${status}/${code} sem repetição ou exposição interna`, async () => {
      await load('empty')
      await choose()
      await evaluate(`attachmentTest.uploadStatus=${JSON.stringify(status)};attachmentTest.code=${JSON.stringify(code)}`)
      await click('Enviar arquivo')
      await wait(`${scope}.textContent.includes(${JSON.stringify(fragment)}) && !${scope}.querySelector('[aria-busy=true]')`)
      assert.equal(await evaluate('attachmentTest.posts.length'), 1)
      if (status === 403) assert.equal(await evaluate('!!document.querySelector("#attachments-title")'), true)
      if (status === 503 || status === 'offline') {
        assert.equal(await evaluate(`[...${scope}.querySelectorAll('button')].find(b=>b.textContent==='Enviar arquivo').disabled`), true)
        await click('Atualizar anexos')
        await wait(`![...${scope}.querySelectorAll('button')].find(b=>b.textContent==='Enviar arquivo').disabled`)
        assert.equal(await evaluate('attachmentTest.posts.length'), 1)
      }
    })
    await t.test('sucesso do POST seguido por falha no GET não permite reenviar automaticamente', async () => {
      await load('empty')
      await choose()
      await evaluate('attachmentTest.listStatus=503')
      await click('Enviar arquivo')
      await wait(`${scope}.textContent.includes('Anexo enviado com sucesso.') && !!${scope}.querySelector('[role=alert]')`)
      assert.equal(await evaluate('attachmentTest.posts.length'), 1)
      await evaluate('attachmentTest.listStatus=200')
      await click('Atualizar anexos')
      await wait(`${scope}.querySelectorAll('li').length===1`)
      assert.equal(await evaluate('attachmentTest.posts.length'), 1)
    })
    await t.test('conflito de status pode ser atualizado e recuperado sem recarregar a página', async () => {
      await load()
      await choose()
      await evaluate('attachmentTest.uploadStatus=409;attachmentTest.code="ticket_not_writable"')
      await click('Enviar arquivo')
      await wait('!document.querySelector("#attachment-file")')
      await evaluate('attachmentTest.uploadStatus=201')
      await click('Atualizar anexos')
      await wait('!!document.querySelector("#attachment-file") && !document.querySelector("#attachment-file").disabled')
      assert.equal(await evaluate('attachmentTest.posts.length'), 1)
    })
    await t.test('perda de acesso remove anexos e visualização; 403 preserva autenticação', async () => {
      await load()
      await action('Visualizar','captura.png')
      await wait('!!document.querySelector("#attachment-preview-title")')
      const url = await evaluate('attachmentTest.urls.at(-1).url')
      await evaluate('attachmentTest.downloadStatus=403')
      await action('Baixar','manual.pdf')
      await wait(`${scope}.textContent.includes('permissão')`)
      assert.equal(await evaluate(`${scope}.querySelectorAll('li').length`), 0)
      assert.equal(await evaluate('!!document.querySelector("#attachment-preview-title")'), false)
      assert.equal(await evaluate('!!document.querySelector("#attachment-file")'), false)
      await wait(`attachmentTest.revoked.includes(${JSON.stringify(url)})`)
      assert.equal(await evaluate('!!document.querySelector("#attachments-title")'), true)
    })
    await t.test('401 session_revoked no download limpa identidade e dados protegidos', async () => {
      await load()
      await evaluate('attachmentTest.downloadStatus=401;attachmentTest.code="session_revoked"')
      await action('Baixar','manual.pdf')
      await wait('!document.querySelector("#attachments-title") && document.body.textContent.includes("Sua sessão foi revogada")')
      assert.equal(await evaluate('document.body.textContent.includes("Chamado com anexos")'), false)
      assert.equal(await evaluate('document.body.textContent.includes("Autor do anexo")'), false)
    })
    await t.test('perda de acesso detectada nos detalhes desmonta anexos e libera preview', async () => {
      await load()
      await action('Visualizar','captura.png')
      await wait('!!document.querySelector("#attachment-preview-title")')
      const url = await evaluate('attachmentTest.urls.at(-1).url')
      await evaluate(`attachmentTest.detailStatus=404;[...document.querySelectorAll('button')].find(b=>b.textContent==='Atualizar conversa').click()`)
      await wait('!document.querySelector("#attachments-title")')
      await wait(`attachmentTest.revoked.includes(${JSON.stringify(url)})`)
      await evaluate(`attachmentTest.detailStatus=200;[...document.querySelectorAll('button')].find(b=>b.textContent==='Atualizar conversa').click()`)
      await wait(`${scope}?.querySelectorAll('li').length===3`)
    })
    await t.test('chamado sem acesso não consulta nem exibe anexos', async () => {
      const boot = await evaluate('attachmentTest.boot')
      await send('Page.navigate', { url: `${browser.baseUrl}?detailStatus=404&case=${crypto.randomUUID()}#/chamados/8` })
      await wait(`window.attachmentTest?.boot && attachmentTest.boot!==${JSON.stringify(boot)} && document.body.textContent.includes('Chamado não encontrado')`)
      assert.equal(await evaluate('attachmentTest.lists'), 0)
      assert.equal(await evaluate('!!document.querySelector("#attachments-title")'), false)
    })
    await t.test('listagem negada não expõe arquivos nem envio e permite atualizar após recuperar acesso', async () => {
      for (const status of [403,404]) {
        await load(`listStatus=${status}`)
        assert.equal(await evaluate(`${scope}.querySelectorAll('li').length`), 0)
        assert.equal(await evaluate('!!document.querySelector("#attachment-file")'), false)
        assert.equal(await evaluate(`${scope}.textContent.includes('relatório.txt')`), false)
        await evaluate('attachmentTest.listStatus=200')
        await click('Atualizar anexos')
        await wait(`${scope}.querySelectorAll('li').length===3`)
      }
    })
    await t.test('resposta de download após navegação não cria Blob nem visualização', async () => {
      await load()
      await evaluate('attachmentTest.downloadDelay=500')
      await action('Visualizar','captura.png')
      await wait('attachmentTest.downloads.length===1')
      await evaluate('location.hash="#/usuarios"')
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(await evaluate('attachmentTest.urls.length'), 0)
      assert.equal(await evaluate('!!document.querySelector("#attachment-preview-title")'), false)
    })
    await t.test('layout responsivo, associação de label, teclado e lista semântica', async () => {
      await load()
      for (const width of [320,375,768,1024,1440]) {
        await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `width ${width}`)
        assert.equal(await evaluate(`${scope}.querySelector('input[type=file]').multiple`), false)
        assert.equal(await evaluate('document.querySelector("label[for=attachment-file]")!==null'), true)
        assert.match(await evaluate('document.querySelector("#attachment-file").getAttribute("aria-describedby")'), /attachment-help/)
      }
      await send('Emulation.setFocusEmulationEnabled',{enabled:true})
      await evaluate(`document.querySelector('button[aria-label="Visualizar relatório.txt"]').focus()`)
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
      await wait('!!document.querySelector("pre")')
      assert.equal(await evaluate('document.activeElement.id'), 'attachment-preview-title')
      const tree = await send('Accessibility.getFullAXTree')
      assert.equal(tree.nodes.some(node=>node.role?.value==='button' && node.name?.value==='Fechar visualização'),true)
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
