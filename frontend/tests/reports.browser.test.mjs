import assert from 'node:assert/strict'
import test from 'node:test'
import { browserExecutable, openBrowser } from './helpers/browser.mjs'
import { reportFixtures } from './helpers/report-fixtures.mjs'

function transport(fixtures) {
  const params = new URLSearchParams(location.search), role = params.get('role') || 'admin'
  const state = window.reportTest = { boot: crypto.randomUUID(), calls: [], summaryStatus: 200, tableStatus: 200, optionsStatus: 200, exportStatus: 200,
    summaryDelay: 0, tableDelay: 0, exportDelay: 200, code: '', urls: [], revoked: [], downloads: [], empty: params.has('empty') }
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), click = HTMLAnchorElement.prototype.click
  URL.createObjectURL = blob => { const url = create(blob); state.urls.push(url); return url }
  URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url) }
  HTMLAnchorElement.prototype.click = function () { if(this.download) state.downloads.push({url:this.href,name:this.download});else click.call(this) }
  const json = (v, status = 200) => new Response(JSON.stringify(v), {status})
  window.fetch = async (url, options = {}) => {
    const u = new URL(url), path = u.pathname, query = Object.fromEntries(u.searchParams)
    if (path === '/api/user') return state.revokeUser ? json({code:'session_revoked'},401) : json({id:1,name:'Administrador de teste',email:'admin@example.invalid',role})
    state.calls.push({path,query,method:options.method,credentials:options.credentials})
    if (path === '/api/reports/tickets/export') {
      const status = state.exportStatus
      await new Promise(resolve=>setTimeout(resolve,state.exportDelay))
      if (status === 'offline') throw TypeError('Offline')
      if (status !== 200) return json({code:state.code, message:'/private/do-not-display'},status)
      return new Response('\uFEFFID;Título\r\n1;Teste',{headers:{'Content-Type':'text/csv; charset=UTF-8'}})
    }
    if (path.startsWith('/api/reports/')) {
      const kind = path.endsWith('/summary') ? 'summary' : path.endsWith('/filters') ? 'options' : 'table'
      const status = state[kind+'Status'], delay=state[kind+'Delay']||0
      const f = fixtures({start_date:query.start_date,end_date:query.end_date},query)
      if (state.empty) {
        f.summary.data.movements={created:0,resolved_distinct:0,closed:0}
        const c=f.summary.data.cohort;c.total=0;c.unassigned.count=0;c.by_status.forEach(r=>r.count=0);c.by_category=[];c.by_priority.forEach(r=>r.count=0)
        for(const name of ['first_response','resolution'])for(const key of Object.keys(f.summary.data.sla[name])) f.summary.data.sla[name][key]=key==='compliance_rate'?null:0
        f.table.data=[];f.table.total=0;f.table.last_page=1;f.table.from=null;f.table.to=null
      }
      await new Promise(resolve=>setTimeout(resolve,delay))
      if (status==='offline')throw TypeError('Offline')
      if (status!==200)return json({code:state.code},status)
      return json(f[kind])
    }
    if (path === '/api/tickets/1000') {
      const row=fixtures().table.data[0]
      return json({...row,title:'Chamado selecionado',description:'Descrição preservada',comments:[],activities:[],updated_at:row.created_at})
    }
    if (path.endsWith('/attachments')) return json({data:[]})
    throw Error('Unexpected mocked API: '+path)
  }
}

test('relatórios administrativos no navegador', {skip:!browserExecutable,timeout:180000}, async t=>{
  const browser=await openBrowser(`(${transport.toString()})(${reportFixtures.toString()})`)
  const {evaluate,wait,send}=browser
  const navigate=async(query='')=>{
    const boot=await evaluate('window.reportTest?.boot')
    await send('Page.navigate',{url:`${browser.baseUrl}?${query}&case=${crypto.randomUUID()}#/relatorios`})
    await wait(`window.reportTest?.boot && reportTest.boot!==${JSON.stringify(boot)}`)
  }
  const load=async(query='')=>{
    await navigate(query)
    await wait(`!!document.querySelector('#report-table-title') && !document.body.textContent.includes('Carregando chamados do relatório...') && !document.body.textContent.includes('Carregando resumo...') && !document.body.textContent.includes('Carregando opções...')`)
  }
  const click=label=>evaluate(`[...document.querySelectorAll('main button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  const field=(id,value)=>evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});const proto=node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const tableReady=()=>wait(`!!document.querySelector('#report-table-title') && !document.body.textContent.includes('Carregando chamados do relatório...')`)
  const apply=async()=>{await click('Aplicar filtros');await tableReady()}
  try {
    await t.test('sidebar ativa para admin e indicadores distinguem movimentos, coorte e SLA',async()=>{
      await load()
      assert.equal(await evaluate(`document.querySelector('a[href="#/relatorios"]').getAttribute('aria-current')`),'page')
      assert.equal(await evaluate(`document.querySelector('a[href="#/relatorios"]').closest('li').textContent.includes('Em breve')`),false)
      assert.equal(await evaluate(`!![...document.querySelectorAll('aside button[disabled]')].find(b=>b.textContent.includes('Configurações'))`),true)
      assert.match(await evaluate(`document.querySelector('section[aria-label="Movimentos do período"]').textContent`),/Com resolução registrada/)
      assert.equal(await evaluate(`document.querySelectorAll('#report-cohort-title + p + div section').length`),3)
      const sla=await evaluate(`document.querySelector('#report-sla-title').parentElement.textContent`)
      assert.match(sla,/50%/);assert.match(sla,/Não disponível/);assert.match(sla,/2 obrigações concluídas avaliáveis/)
      assert.match(sla,/Não avaliável/);assert.doesNotMatch(sla,/(?:^|\s)0%/)
      assert.match(await evaluate('document.body.textContent'),/Prazos atualmente registrados/)
    })
    await t.test('requester e technician não consultam endpoints mesmo com hash direto',async()=>{
      for(const role of ['requester','technician']) {
        await navigate('role='+role)
        await wait(`document.querySelector('main h1')?.textContent==='Acesso não permitido'`)
        assert.equal(await evaluate(`reportTest.calls.filter(c=>c.path.startsWith('/api/reports/')).length`),0)
        assert.equal(await evaluate(`!!document.querySelector('a[href="#/relatorios"]')`),false)
        assert.equal(await evaluate(`!![...document.querySelectorAll('aside button[disabled]')].find(b=>b.textContent.includes('Relatórios'))`),true)
      }
    })
    await t.test('filtros combinados preservam cartões, incluem inativos e reiniciam paginação',async()=>{
      await load()
      assert.match(await evaluate(`document.querySelector('#report-assignee').textContent`),/Desativado/)
      assert.match(await evaluate(`document.querySelector('#report-category').textContent`),/Inativa/)
      const summaries=await evaluate(`reportTest.calls.filter(c=>c.path.endsWith('/summary')).length`)
      for(const[id,v]of[['report-assignee','8'],['report-category','1'],['report-priority','urgent'],['report-status','open']])await field(id,v)
      assert.equal(await evaluate(`!![...document.querySelectorAll('main button')].find(b=>b.textContent==='Exportar CSV'&&b.disabled)`),true)
      await apply()
      await wait(`reportTest.calls.filter(c=>c.path==='/api/reports/tickets').at(-1).query.priority==='urgent'`)
      const query=await evaluate(`reportTest.calls.filter(c=>c.path==='/api/reports/tickets').at(-1).query`)
      assert.equal(query.assigned_to,'8');assert.equal(query.category_id,'1');assert.equal(query.status,'open');assert.equal(query.page,'1')
      assert.equal(await evaluate(`reportTest.calls.filter(c=>c.path.endsWith('/summary')).length`),summaries)
      await click('Próxima');await tableReady()
      await wait(`document.querySelector('section[aria-labelledby=report-table-title]').textContent.includes('Página 2 de 3')`)
      assert.equal(await evaluate(`reportTest.calls.filter(c=>c.path==='/api/reports/tickets').at(-1).query.assigned_to`),'8')
      assert.equal(await evaluate(`document.querySelector('#report-priority').value`),'urgent')
      assert.equal(await evaluate('document.activeElement.id'),'report-table-title')
    })
    await t.test('período refaz resumo e tabela com datas; resumo nunca recebe filtros extras',async()=>{
      await load();await field('report-start','2026-09-01');await field('report-end','2026-09-30');await field('report-assignee','unassigned');await apply()
      await wait(`reportTest.calls.filter(c=>c.path.endsWith('/summary')).at(-1).query.start_date==='2026-09-01'`)
      assert.deepEqual(Object.keys(await evaluate(`reportTest.calls.filter(c=>c.path.endsWith('/summary')).at(-1).query`)),['start_date','end_date'])
      await tableReady();assert.match(await evaluate(`document.querySelector('section[aria-labelledby=report-table-title]').textContent`),/Sem responsável/)
      assert.match(await evaluate('document.body.textContent'),/Período aplicado: 01\/09\/2026 a 30\/09\/2026/)
    })
    await t.test('datas inválidas ou maiores que um ano não chegam à API',async()=>{
      await load();const count=await evaluate('reportTest.calls.length')
      await field('report-start','2026-10-02');await field('report-end','2026-10-01');await click('Aplicar filtros')
      await wait(`!!document.querySelector('#report-period-error')`)
      assert.equal(await evaluate('document.activeElement.id'),'report-start')
      await field('report-start','2026-01-01');await field('report-end','2027-01-01');await click('Aplicar filtros')
      await wait(`document.querySelector('#report-period-error')?.textContent.includes('ano')`)
      assert.equal(await evaluate('reportTest.calls.length'),count)
    })
    await t.test('CSV autenticado mantém seleção/página, bloqueia duplicação e libera Blob',async()=>{
      await load();await field('report-priority','high');await apply();await click('Próxima');await tableReady()
      await wait(`document.querySelector('section[aria-labelledby=report-table-title]').textContent.includes('Página 2')`)
      await evaluate(`reportTest.exportDelay=500`);await click('Exportar CSV')
      await wait(`document.body.textContent.includes('Preparando CSV...')`)
      assert.equal(await evaluate(`document.querySelector('#report-start').matches(':disabled')`),true)
      await click('Preparando CSV...')
      await wait(`reportTest.downloads.length===1`)
      const exports=await evaluate(`reportTest.calls.filter(c=>c.path.endsWith('/export'))`)
      assert.equal(exports.length,1);assert.equal(exports[0].query.priority,'high');assert.equal(exports[0].query.page,'2');assert.equal(exports[0].credentials,'include')
      assert.equal(await evaluate(`reportTest.downloads[0].name`),'flowdesk-chamados.csv')
      assert.equal(await evaluate(`reportTest.downloads[0].url.startsWith('blob:')`),true)
      await wait(`reportTest.revoked.includes(reportTest.downloads[0].url)`)
      assert.equal(await evaluate(`document.querySelector('#report-priority').value`),'high')
    })
    for(const[status,code,fragment]of[[422,'export_limit_exceeded','5.000'],[422,'','Filtros inválidos'],[503,'report_unavailable','indisponíveis'],['offline','','conexão']])await t.test(`erro de exportação ${status}/${code} não repete requisição`,async()=>{
      await load();await evaluate(`reportTest.exportStatus=${JSON.stringify(status)};reportTest.code=${JSON.stringify(code)}`);await click('Exportar CSV')
      await wait(`document.querySelector('main [role=alert]')?.textContent.includes(${JSON.stringify(fragment)})`)
      assert.equal(await evaluate('reportTest.downloads.length'),0)
      assert.equal(await evaluate(`reportTest.calls.filter(c=>c.path.endsWith('/export')).length`),1)
      assert.equal(await evaluate('document.body.textContent.includes("/private/")'),false)
    })
    await t.test('falha de resumo não fabrica zeros e não impede consulta da tabela',async()=>{
      await load();await evaluate('reportTest.summaryStatus=503')
      await field('report-start','2026-08-01');await field('report-end','2026-08-30');await apply()
      await wait(`!!document.querySelector('section[aria-label="Movimentos do período"] [role=alert]')`)
      assert.equal(await evaluate(`document.querySelectorAll('section[aria-label="Movimentos do período"] article p[aria-label="Indicador indisponível"]').length`),3)
      assert.equal(await evaluate(`document.querySelector('table tbody tr')!==null`),true)
    })
    await t.test('falhas de tabela e catálogo são recuperáveis e mantêm seleções',async()=>{
      await load();await field('report-priority','urgent');await evaluate('reportTest.tableStatus=422');await apply()
      await wait(`document.querySelector('section[aria-labelledby=report-table-title] [role=alert]')?.textContent.includes('Filtros inválidos')`)
      await evaluate('reportTest.tableStatus=200');await click('Tentar novamente');await tableReady()
      assert.equal(await evaluate(`document.querySelector('#report-priority').value`),'urgent')
      await evaluate('reportTest.optionsStatus=503');await field('report-start','2026-07-01');await field('report-end','2026-07-30');await apply()
      await wait(`document.querySelector('form [role=alert]')?.textContent.includes('indisponíveis')`)
      assert.equal(await evaluate(`document.querySelector('#report-priority').value`),'urgent')
      await evaluate('reportTest.optionsStatus=200');await click('Recarregar opções')
      await wait(`!document.querySelector('#report-priority').disabled`)
      assert.equal(await evaluate(`document.querySelector('#report-priority').value`),'urgent')
    })
    await t.test('ausência de resultados mantém denominador nulo e indicação explícita',async()=>{
      await load('empty=1')
      assert.match(await evaluate('document.body.textContent'),/Nenhum chamado encontrado/)
      assert.equal(await evaluate(`document.querySelectorAll('#report-sla-title + p + div section p').length>0`),true)
      assert.equal(await evaluate(`document.querySelector('#report-sla-title').parentElement.textContent.includes('0%')`),false)
    })
    for(const[status,code]of[[403,''],[401,''],[419,'']])await t.test(`HTTP ${status} limpa os dados protegidos sem logout genérico`,async()=>{
      await load();await evaluate(`reportTest.exportStatus=${status};reportTest.code=${JSON.stringify(code)}`);await click('Exportar CSV')
      await wait(`!document.querySelector('#report-table-title') && document.body.textContent.includes('Relatórios indisponíveis para esta sessão')`)
      assert.equal(await evaluate(`document.body.textContent.includes('Chamado de relatório 1')`),false)
      assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Sair')`),true)
    })
    await t.test('401 session_revoked em download remove identidade e dados do relatório',async()=>{
      await load();await evaluate('reportTest.exportStatus=401;reportTest.code="session_revoked"');await click('Exportar CSV')
      await wait(`document.body.textContent.includes('Sua sessão foi revogada') && !document.querySelector('#report-table-title')`)
      assert.equal(await evaluate(`document.body.textContent.includes('Administrador de teste')`),false)
    })
    await t.test('revogação em outra requisição cancela exportação pendente e não entrega Blob antigo',async()=>{
      await load();await evaluate('reportTest.exportDelay=600');await click('Exportar CSV')
      await wait(`reportTest.calls.some(c=>c.path.endsWith('/export'))`)
      await evaluate(`reportTest.revokeUser=true;import('/src/services/api.ts').then(api=>api.apiRequest('/user')).catch(()=>{})`)
      await wait(`document.body.textContent.includes('Sua sessão foi revogada')`)
      await new Promise(resolve=>setTimeout(resolve,700))
      assert.equal(await evaluate('reportTest.downloads.length'),0)
      assert.equal(await evaluate('reportTest.urls.length'),0)
    })
    await t.test('respostas antigas e downloads após navegação não reaparecem',async()=>{
      await load();await evaluate('reportTest.tableDelay=500');await field('report-priority','low');await apply()
      await field('report-priority','urgent');await evaluate('reportTest.tableDelay=0');await apply()
      await new Promise(resolve=>setTimeout(resolve,650));await tableReady()
      assert.equal(await evaluate(`document.querySelector('#report-priority').value`),'urgent')
      await evaluate('reportTest.exportDelay=500');await click('Exportar CSV');await evaluate('location.hash="#/usuarios"')
      await new Promise(resolve=>setTimeout(resolve,650))
      assert.equal(await evaluate('reportTest.downloads.length'),0)
    })
    await t.test('link abre o chamado selecionado usando navegação existente',async()=>{
      await load();await evaluate(`document.querySelector('a[href="#/chamados/1000"]').click()`)
      await wait(`document.querySelector('main h1')?.textContent==='Chamado selecionado'`)
    })
    await t.test('responsividade, teclado e nomes acessíveis',async()=>{
      await load()
      for(const width of [320,375,768,1024,1440]) {
        await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`width ${width}`)
        assert.equal(await evaluate(`document.querySelector('table').closest('[role=region]').scrollWidth>0`),true)
      }
      await send('Emulation.setFocusEmulationEnabled',{enabled:true})
      await evaluate(`document.querySelector('#report-start').focus()`)
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      const tree=await send('Accessibility.getFullAXTree')
      assert.equal(tree.nodes.some(n=>n.role?.value==='button'&&n.name?.value==='Exportar CSV'),true)
      assert.equal(await evaluate(`document.querySelectorAll('th[scope=col]').length`),12)
      assert.equal(await evaluate(`document.querySelector('label[for=report-start]')!==null`),true)
    })
    assert.deepEqual(browser.errors,[])
  }finally{await browser.close()}
})
