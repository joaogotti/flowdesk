import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const records = [{ id: 8, name: 'Software', is_active: false, tickets_count: 1200 }, { id: 2, name: 'Hardware', is_active: true, tickets_count: 0 }]
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('categorias administrativas: GET com sessão, sinal, contrato e ordem da API', async () => {
  const controller = new AbortController()
  const { getAdminCategories } = await runtime(async (url, options) => {
    assert.equal(url, 'http://localhost:8000/api/admin/categories')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.headers.get('Accept'), 'application/json')
    assert.equal(options.signal.aborted, false)
    assert.equal(options.body, undefined)
    return json({ data: records.map(row => ({ ...row, private: 'omit' })) })
  })('services/admin-categories')
  assert.deepEqual(JSON.parse(JSON.stringify(await getAdminCategories(controller.signal))), records)
})

test('categorias administrativas: lista vazia válida', async () => {
  const { getAdminCategories } = await runtime(async () => json({ data: [] }))('services/admin-categories')
  assert.deepEqual(JSON.parse(JSON.stringify(await getAdminCategories())), [])
})

test('categorias administrativas: valida envelope, ID, nome, booleano e contagem', async () => {
  let body
  const { getAdminCategories } = await runtime(async () => json(body))('services/admin-categories')
  for (const invalid of [null, [], {}, { data: null }, { data: {} }, { data: [null] }, { data: [records[0], records[0]] }]) {
    body = invalid
    await assert.rejects(getAdminCategories(), /formato esperado/)
  }
  for (const [field, values] of Object.entries({
    id: [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1],
    name: ['', '  ', 1, null], is_active: [0, 1, 'true', null],
    tickets_count: [-1, 1.5, '0', null, Number.MAX_SAFE_INTEGER + 1],
  })) for (const value of [undefined, ...values]) {
    body = { data: [{ ...records[0], [field]: value }] }
    await assert.rejects(getAdminCategories(), /formato esperado/)
  }
})

for (const status of [201, 204, 401, 403, 419, 500, 503]) test(`categorias administrativas: HTTP ${status} e mensagem existente`, async () => {
  const load = runtime(async () => status === 204 ? new Response(null, { status }) : json({}, status))
  const { getAdminCategories } = await load('services/admin-categories')
  const { getCategoriesErrorMessage } = await load('services/categories')
  await assert.rejects(getAdminCategories(), error => {
    assert.match(getCategoriesErrorMessage(error), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : /Não foi possível carregar/)
    return true
  })
})

test('categorias administrativas: rede, JSON inválido e cancelamento', async () => {
  for (const fetch of [async () => { throw TypeError('Offline') }, async () => new Response('{'), async () => { throw new DOMException('Aborted', 'AbortError') }]) {
    const { getAdminCategories } = await runtime(fetch)('services/admin-categories')
    await assert.rejects(getAdminCategories())
  }
})

test('rota administrativa segue navegação por hash existente', async () => {
  const { parseWorkspaceHash } = await runtime()('utils/navigation')
  assert.equal(parseWorkspaceHash('#/categorias').page, 'categories')
  assert.equal(parseWorkspaceHash('#/chamados').page, 'tickets')
})

test('cadastro administrativo: CSRF e POST exclusivo name normalizado, sem campos extras', async () => {
  const calls = []
  const { createAdminCategory } = await runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : json({ data: { id: 3, name: 'Periféricos', is_active: true, tickets_count: 0 } }, 201)
  })('services/admin-categories')
  await createAdminCategory({ name: ' \tPeriféricos\n ', is_active: false, id: 7 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/admin/categories')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.headers.get('Content-Type'), 'application/json')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Periféricos' })
})

test('cadastro administrativo: vazio, limite e caractere inválido sem rede', async () => {
  let calls = 0
  const { createAdminCategory } = await runtime(async () => { calls++; return new Response(null, { status: 204 }) })('services/admin-categories')
  for (const name of ['', ' \n ', 'a'.repeat(101), 'a\0b']) await assert.rejects(createAdminCategory({ name }))
  assert.equal(calls, 0)
})

test('cadastro administrativo: aceita 100 caracteres Unicode', async () => {
  const { createAdminCategory } = await runtime(async url => url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : json({}, 201))('services/admin-categories')
  await createAdminCategory({ name: 'é'.repeat(100) })
})

for (const status of [200, 202, 204, 401, 403, 419, 422, 500]) test(`cadastro administrativo: POST ${status} não confirma sucesso`, async () => {
  const load = runtime(async url => url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : status === 204 ? new Response(null, { status }) : json({ errors: { name: ['Já existe uma categoria com esse nome.'] } }, status))
  const { createAdminCategory, getCreateCategoryErrorMessage } = await load('services/admin-categories')
  await assert.rejects(createAdminCategory({ name: 'Hardware' }), error => {
    assert.match(getCreateCategoryErrorMessage(error), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 422 ? /nome informado/ : /Não foi possível confirmar/)
    if (status === 422) assert.equal(error.validationErrors.name[0], 'Já existe uma categoria com esse nome.')
    return true
  })
})

test('cadastro administrativo: CSRF falho impede POST e rede falha sem retry automático', async () => {
  for (const failure of ['csrf', 'post']) {
    let posts = 0
    const { createAdminCategory } = await runtime(async url => {
      if (url.endsWith('/sanctum/csrf-cookie')) {
        if (failure === 'csrf') return json({}, 419)
        return new Response(null, { status: 204 })
      }
      posts++
      throw TypeError('Offline')
    })('services/admin-categories')
    await assert.rejects(createAdminCategory({ name: 'Rede' }))
    assert.equal(posts, failure === 'csrf' ? 0 : 1)
  }
})

test('edição administrativa: PATCH somente name, normalizado, cookies e CSRF', async () => {
  const calls = []
  const { updateAdminCategory } = await runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : json({ data: records[0] })
  })('services/admin-categories')
  await updateAdminCategory(8, { name: ' \tPeriféricos\n ', id: 99, is_active: true, tickets_count: 10 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/admin/categories/8')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.equal(calls[1].options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Periféricos' })
})

test('edição administrativa: IDs e nomes inválidos não enviam CSRF ou PATCH', async () => {
  let calls = 0
  const { updateAdminCategory } = await runtime(async () => { calls++; return json({}) })('services/admin-categories')
  for (const id of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(updateAdminCategory(id, { name: 'Teste' }))
  for (const name of ['', '   ', 'a'.repeat(101), 'a\0b']) await assert.rejects(updateAdminCategory(1, { name }))
  assert.equal(calls, 0)
})

for (const status of [201, 202, 204, 401, 403, 404, 419, 422, 500]) test(`edição administrativa: HTTP ${status} mantém erro sem repetir PATCH`, async () => {
  let patches = 0
  const { updateAdminCategory, getUpdateCategoryErrorMessage } = await runtime(async url => {
    if (url.endsWith('/sanctum/csrf-cookie')) return new Response(null, { status: 204 })
    patches++
    return status === 204 ? new Response(null, { status }) : json({ errors: { name: ['Já existe uma categoria com esse nome.'] } }, status)
  })('services/admin-categories')
  await assert.rejects(updateAdminCategory(8, { name: 'Hardware' }), error => {
    assert.match(getUpdateCategoryErrorMessage(error), [401, 419].includes(status) ? /sessão expirou/ : status === 403 ? /permissão/ : status === 404 ? /não existe/ : status === 422 ? /nome informado/ : /Não foi possível confirmar/)
    if (status === 422) assert.equal(error.validationErrors.name[0], 'Já existe uma categoria com esse nome.')
    return true
  })
  assert.equal(patches, 1)
})

test('edição administrativa: falhas de CSRF e rede não geram retries', async () => {
  for (const stage of ['csrf', 'patch']) {
    let patches = 0
    const { updateAdminCategory } = await runtime(async url => {
      if (url.endsWith('/sanctum/csrf-cookie')) {
        if (stage === 'csrf') return json({}, 419)
        return new Response(null, { status: 204 })
      }
      patches++
      throw TypeError('Offline')
    })('services/admin-categories')
    await assert.rejects(updateAdminCategory(8, { name: 'Teste' }))
    assert.equal(patches, stage === 'csrf' ? 0 : 1)
  }
})
