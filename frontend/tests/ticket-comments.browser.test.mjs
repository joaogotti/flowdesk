import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'

// Fixtures exclusivas do teste. Nenhuma requisição da aplicação alcança o backend.
function transport() {
  const date = '2026-10-21T20:43:42Z'
  const params = new URLSearchParams(location.search)
  const role = params.get('role') || 'technician'
  const status = params.get('status') || 'open'
  const ticket = {
    id: 8, title: 'Chamado de teste', description: 'Descrição de teste', priority: 'medium',
    requester: { id: 1, name: 'Solicitante de teste' }, assignee: null,
    category: { id: 1, name: 'Categoria de teste' }, status: { id: 1, code: status, name: status },
    created_at: date, updated_at: date, first_response_due_at: '2026-10-22T20:43:42Z',
    resolution_due_at: '2026-10-23T20:43:42Z', first_responded_at: null,
    resolved_at: null, closed_at: null, comments: [], activities: [],
  }
  window.commentTest = { boot: crypto.randomUUID(), posts: [], gets: 0, status: 201, failGet: false, ticket,
    getDelay: Number(params.get('detailDelay') || 0), getStatus: Number(params.get('detailError') || 200) }
  window.fetch = async (url, options = {}) => {
    const state = window.commentTest
    const path = new URL(url).pathname
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/user') return json({ id: 1, name: 'Usuário de teste', email: 'teste@example.invalid', role })
    if (path === '/sanctum/csrf-cookie') {
      document.cookie = 'XSRF-TOKEN=test-only'
      return new Response(null, { status: 204 })
    }
    if (path === '/api/tickets/8/comments' && options.method === 'POST') {
      const input = JSON.parse(options.body)
      state.posts.push(input)
      await new Promise(resolve => setTimeout(resolve, 200))
      if (state.status === 'offline') throw TypeError('Offline')
      if (state.status !== 201) return json({ errors: { body: ['Conteúdo inválido do teste.'] } }, state.status)
      const comment = { id: state.posts.length, body: input.body, is_internal: input.is_internal, author: { id: 1, name: 'Usuário de teste' }, created_at: date }
      ticket.comments.push(comment)
      ticket.activities.push({ id: state.posts.length, action: 'comment_added', actor: comment.author, created_at: date })
      if (!input.is_internal && role !== 'requester') ticket.first_responded_at = date
      return json(comment, 201)
    }
    if (path === '/api/tickets/8') {
      state.gets++
      if (state.getDelay) await new Promise(resolve => setTimeout(resolve, state.getDelay))
      if (state.failGet) return json({}, 503)
      if (state.getStatus !== 200) return json({}, state.getStatus)
      return json(ticket)
    }
    throw Error(`Requisição inesperada: ${path}`)
  }
}

test('formulário de comentários no navegador', { skip: !browserExecutable, timeout: 90000 }, async t => {
  const browser = await openBrowser(`(${transport.toString()})()`)
  const { evaluate, wait, send } = browser
  const body = value => evaluate(`(() => {
    const input = document.querySelector('textarea[name=body]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const submit = () => evaluate(`document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`)
  const navigate = async (query = '') => {
    const boot = await evaluate('window.commentTest?.boot')
    await send('Page.navigate', { url: `${browser.baseUrl}?${query}&test=${crypto.randomUUID()}#/chamados/8` })
    await wait(`!!window.commentTest && window.commentTest.boot !== ${JSON.stringify(boot)}`)
  }
  const load = async (role = 'technician', status = 'open') => {
    await navigate(`role=${role}&status=${status}`)
    await wait('document.querySelector("h1")?.textContent === "Chamado de teste"')
  }
  try {
    await t.test('campo compacto preserva largura, digitação longa, contador, limite e envio', async () => {
      await load()
      const longBody = `Primeira linha\n${'x'.repeat(9985)}`
      assert.equal(longBody.length, 10000)
      for (const width of [320, 375, 768, 1024, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
        await body('')
        const layout = await evaluate(`(() => {
          const field=document.querySelector('textarea'), form=field.closest('form');
          const rect=field.getBoundingClientRect();
          const internal=form.querySelector('input[name=is_internal]').closest('div');
          const button=form.querySelector('button[type=submit]');
          return { height:rect.height, width:rect.width, formWidth:form.getBoundingClientRect().width,
            pageFits:document.documentElement.scrollWidth<=innerWidth, resize:getComputedStyle(field).resize,
            required:field.required, maxLength:field.maxLength,
            internalGap:internal.getBoundingClientRect().top-document.querySelector('#comment-count').getBoundingClientRect().bottom,
            submitGap:button.getBoundingClientRect().top-internal.getBoundingClientRect().bottom };
        })()`)
        assert.ok(layout.height >= 80 && layout.height <= 100, `initial height at ${width}: ${layout.height}`)
        assert.equal(layout.width, layout.formWidth)
        assert.equal(layout.pageFits, true)
        assert.equal(layout.resize, 'vertical')
        assert.equal(layout.required, true)
        assert.equal(layout.maxLength, 10000)
        assert.ok(layout.internalGap >= 16)
        assert.ok(layout.submitGap >= 20)
        await evaluate('document.querySelector("textarea").focus()')
        await send('Input.insertText', { text: 'Mensagem curta' })
        assert.equal(await evaluate('document.querySelector("textarea").value'), 'Mensagem curta')
        assert.match(await evaluate('document.querySelector("#comment-count").textContent'), /14 \/ 10\.000/)
        await body('')
        await send('Input.insertText', { text: longBody })
        await send('Input.insertText', { text: '!' })
        assert.equal(await evaluate('document.querySelector("textarea").value'), longBody)
        assert.match(await evaluate('document.querySelector("#comment-count").textContent'), /10\.000 \/ 10\.000/)
        assert.equal(await evaluate('document.querySelector("textarea").getBoundingClientRect().height'), layout.height)
        assert.equal(await evaluate('document.querySelector("textarea").scrollHeight > document.querySelector("textarea").clientHeight'), true)
      }
      await submit()
      await wait('document.querySelectorAll("article").length===1 && !document.querySelector("textarea").disabled')
      assert.deepEqual(await evaluate('commentTest.posts'), [{ body: longBody, is_internal: false }])
      assert.equal(await evaluate('document.querySelector("textarea").value'), '')
      assert.match(await evaluate('document.querySelector("#comment-count").textContent'), /0 \/ 10\.000/)
    })
    await t.test('altura natural com zero, uma, várias e mensagens longas em 320 a 1440 px', async () => {
      await load()
      const baseline = new Map()
      const longBody = `Texto longo com espaços e quebras.\n${'Conteúdo legível. '.repeat(150)}\n${'x'.repeat(2500)}`
      for (const [variant, bodies] of [
        ['empty', []], ['single', ['Mensagem curta']],
        ['many', Array.from({ length: 12 }, (_, i) => `Mensagem ${i + 1}`)], ['long', [longBody]],
      ]) {
        const comments = bodies.map((body, index) => ({ id: index + 1, body, is_internal: index % 2 === 1,
          author: { id: 1, name: 'Autor de teste' }, created_at: '2026-10-21T20:43:42Z' }))
        await evaluate(`commentTest.ticket.comments=${JSON.stringify(comments)}; [...document.querySelectorAll('button')].find(b=>b.textContent==='Atualizar conversa').click()`)
        await wait(`document.querySelectorAll('section[aria-labelledby=conversation-title] article').length===${comments.length} && !document.querySelector('textarea').disabled`)
        assert.deepEqual(await evaluate('[...document.querySelectorAll("article p")].map(p=>p.textContent)'), bodies)
        assert.equal(await evaluate('document.querySelectorAll("article span").length > 0'), comments.length > 0)
        if (variant === 'many') assert.equal(await evaluate('[...document.querySelectorAll("article")].filter(a=>a.textContent.includes("Interno")).length'), 6)
        for (const width of [320, 375, 768, 1024, 1440]) {
          await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
          const layout = await evaluate(`(() => {
            const section=document.querySelector('section[aria-labelledby=conversation-title]');
            const content=section.children[1], rect=content.getBoundingClientRect();
            const items=[...content.querySelectorAll('li')];
            const field=section.querySelector('textarea');
            const formBlock=section.querySelector('form').parentElement;
            return { pageFits:document.documentElement.scrollWidth<=innerWidth,
              contentHeight:rect.height, itemHeight:items.reduce((sum,item)=>sum+item.getBoundingClientRect().height,0),
              formGap:formBlock.getBoundingClientRect().top-rect.bottom,
              noInternalScroll:content.scrollHeight<=content.clientHeight+1 && !['auto','scroll'].includes(getComputedStyle(content).overflowY),
              messagesFit:[...content.querySelectorAll('p')].every(p=>p.scrollWidth<=p.clientWidth+1),
              textareaHeight:field.getBoundingClientRect().height, textareaRows:field.rows,
              headerHeight:section.firstElementChild.getBoundingClientRect().height,
              preservesNewlines:[...content.querySelectorAll('article p')].every(p=>getComputedStyle(p).whiteSpace==='pre-wrap') };
          })()`)
          assert.equal(layout.pageFits, true, `${variant} at ${width}`)
          assert.equal(layout.messagesFit, true, `${variant} at ${width}`)
          assert.equal(layout.noInternalScroll, true, `${variant} at ${width}`)
          assert.equal(layout.preservesNewlines, true)
          assert.ok(Math.abs(layout.formGap) <= 1, `${variant}: form follows messages at ${width}`)
          assert.equal(layout.textareaRows, 3)
          if (variant === 'empty') {
            assert.match(await evaluate('document.querySelector("section[aria-labelledby=conversation-title]").textContent'), /Ainda não há comentários/)
            assert.ok(layout.contentHeight < 256, `empty content has no forced blank area at ${width}`)
            baseline.set(width, layout)
          } else {
            assert.ok(Math.abs(layout.contentHeight - layout.itemHeight) <= 1, `${variant}: no unused list height at ${width}`)
            assert.equal(layout.textareaHeight, baseline.get(width).textareaHeight)
            assert.equal(layout.headerHeight, baseline.get(width).headerHeight)
          }
        }
      }
      assert.equal(await evaluate('commentTest.posts.length'), 0)
    })
    await t.test('carregamento inicial e erro mantêm os estados da página e permitem tentar novamente', async () => {
      await navigate('detailDelay=900')
      await wait('!!document.querySelector("[role=status][aria-busy=true]")')
      assert.equal(await evaluate('!!document.querySelector("#conversation-title")'), false)
      await wait('!!document.querySelector("#conversation-title")')
      await navigate('detailError=503')
      await wait('!!document.querySelector("main [role=alert]")')
      assert.equal(await evaluate('!!document.querySelector("#conversation-title")'), false)
      await evaluate('commentTest.getStatus=200; [...document.querySelectorAll("main button")].find(b=>b.textContent==="Tentar novamente").click()')
      await wait('!!document.querySelector("#conversation-title")')
      assert.equal(await evaluate('commentTest.posts.length'), 0)
    })
    await t.test('conversa mantém semântica, navegação por teclado e conteúdo durante atualização e falha', async () => {
      await load()
      await evaluate(`commentTest.ticket.comments=[{id:1,author:{id:1,name:'Autor de teste'},body:'Mensagem preservada',created_at:'2026-10-21T20:43:42Z'}]; [...document.querySelectorAll('button')].find(b=>b.textContent==='Atualizar conversa').click()`)
      await wait('document.querySelectorAll("article").length===1')
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=conversation-title] ol li article").getAttribute("aria-label")'), 'Comentário de Autor de teste')
      assert.equal(await evaluate('document.querySelector("label[for=comment-body]")!==null'), true)
      assert.match(await evaluate('document.querySelector("textarea").getAttribute("aria-describedby")'), /comment-count/)
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Atualizar conversa").focus()')
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.id'), 'comment-body')
      const height = await evaluate('document.querySelector("section[aria-labelledby=conversation-title] ol").getBoundingClientRect().height')
      await evaluate('commentTest.getDelay=600;commentTest.failGet=true;[...document.querySelectorAll("button")].find(b=>b.textContent==="Atualizar conversa").click()')
      await wait('document.querySelector("textarea").disabled')
      assert.match(await evaluate('document.querySelector("section[aria-labelledby=conversation-title]").textContent'), /Atualizando conversa/)
      await wait('!document.querySelector("textarea").disabled && !!document.querySelector("section[aria-labelledby=conversation-title] [role=alert]")')
      assert.equal(await evaluate('document.querySelector("article p").textContent'), 'Mensagem preservada')
      assert.equal(await evaluate('document.querySelector("section[aria-labelledby=conversation-title] ol").getBoundingClientRect().height'), height)
      assert.equal(await evaluate('commentTest.posts.length'), 0)
    })
    await t.test('requester envia público, sem opção interna, e atualiza conversa sem duplicar', async () => {
      await load('requester')
      assert.equal(await evaluate('!!document.querySelector("input[name=is_internal]")'), false)
      await body('  Mensagem pública  ')
      await submit()
      await wait('document.body.textContent.includes("Mensagem enviada com sucesso.") && document.querySelectorAll("article").length === 1')
      assert.deepEqual(await evaluate('commentTest.posts'), [{ body: 'Mensagem pública', is_internal: false }])
      assert.equal(await evaluate('commentTest.gets'), 2)
      assert.equal(await evaluate('document.querySelector("textarea").value'), '')
    })
    for (const role of ['technician', 'admin']) await t.test(`${role} envia interno e redefine a opção`, async () => {
      await load(role)
      assert.equal(await evaluate('document.querySelector("input[name=is_internal]").checked'), false)
      await evaluate('document.querySelector("input[name=is_internal]").click()')
      await body('Mensagem interna')
      await submit()
      await wait('document.querySelectorAll("article").length === 1 && !document.querySelector("textarea").disabled')
      assert.equal(await evaluate('commentTest.posts[0].is_internal'), true)
      assert.equal(await evaluate('document.querySelector("input[name=is_internal]").checked'), false)
      assert.equal(await evaluate('document.querySelector("article").textContent.includes("Interno")'), true)
    })
    await t.test('validação vazia e limite antes de qualquer POST', async () => {
      await load()
      await body('  \n  ')
      await submit()
      await wait('!!document.querySelector("#comment-body-error")')
      assert.equal(await evaluate('document.activeElement.id'), 'comment-body')
      await body('x'.repeat(10001))
      await submit()
      await wait('document.querySelector("#comment-body-error")?.textContent.includes("10.000")')
      assert.equal(await evaluate('commentTest.posts.length'), 0)
      assert.equal(await evaluate('document.querySelector("textarea").maxLength'), 10000)
    })
    await t.test('bloqueia dois submits na mesma execução e atualiza histórico e SLA sem mover o foco ao título', async () => {
      await load()
      await body('Resposta pública')
      await evaluate('document.querySelector("button[type=submit]").focus(); for(let i=0;i<2;i++) document.querySelector("form").dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))')
      await wait('document.querySelectorAll("article").length === 1 && !document.querySelector("textarea").disabled')
      assert.equal(await evaluate('commentTest.posts.length'), 1)
      assert.equal(await evaluate('document.body.textContent.includes("Comentário adicionado")'), true)
      assert.equal(await evaluate('document.body.textContent.includes("Primeira resposta registrada")'), true)
      assert.notEqual(await evaluate('document.activeElement.tagName'), 'H1')
    })
    await t.test('erros preservam texto, mostram validação e permitem nova tentativa', async () => {
      await load()
      for (const status of [401, 403, 404, 409, 419, 422, 500, 'offline']) {
        await evaluate(`commentTest.status = ${JSON.stringify(status)}`)
        await body('Texto preservado')
        await submit()
        await wait('!document.querySelector("textarea").disabled && !!document.querySelector("form [role=alert]")')
        assert.equal(await evaluate('document.querySelector("textarea").value'), 'Texto preservado')
        assert.equal(await evaluate('document.body.textContent.includes("Mensagem enviada com sucesso.")'), false)
      }
    })
    await t.test('POST 201 e GET falho mantêm sucesso; tentar atualizar faz somente GET', async () => {
      await load()
      await evaluate('commentTest.failGet = true')
      await body('Mensagem já persistida')
      await submit()
      await wait('document.body.textContent.includes("A conversa não pôde ser atualizada.")')
      assert.equal(await evaluate('document.body.textContent.includes("Mensagem enviada com sucesso.")'), true)
      assert.equal(await evaluate('document.querySelector("textarea").value'), '')
      assert.equal(await evaluate('document.querySelectorAll("article").length'), 0)
      await evaluate('commentTest.failGet = false; [...document.querySelectorAll("button")].find(b => b.textContent === "Atualizar conversa").click()')
      await wait('document.querySelectorAll("article").length === 1')
      assert.equal(await evaluate('commentTest.posts.length'), 1)
      assert.equal(await evaluate('commentTest.gets'), 3)
    })
    for (const status of ['resolved', 'closed', 'cancelled']) await t.test(`${status} não apresenta formulário ativo`, async () => {
      await load('technician', status)
      assert.equal(await evaluate('!!document.querySelector("textarea")'), false)
      assert.equal(await evaluate('document.body.textContent.includes("não aceita novos comentários")'), true)
      assert.equal(await evaluate('commentTest.posts.length'), 0)
    })
    await t.test('conversa preserva responsividade em desktop e mobile', async () => {
      await load()
      for (const width of [1440, 1024, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
      }
    })
    assert.deepEqual(browser.errors, [])
  } finally { await browser.close() }
})
