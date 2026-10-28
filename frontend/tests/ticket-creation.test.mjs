import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const input = { title: 'Título', description: 'Descrição', category_id: 4, priority: 'urgent' }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('POST inicializa CSRF e envia somente os quatro campos com cookies', async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/sanctum/csrf-cookie') ? new Response(null, { status: 204 }) : json({ id: 47, requester: { id: 1 }, internal: 'Não expor' }, 201)
  })
  const { createTicket } = await load('services/tickets')
  const created = await createTicket({ ...input, title: `  ${input.title} \n`, description: `\t${input.description}  `, status: 'closed', requester_id: 99, assigned_to: 99 })
  assert.deepEqual(JSON.parse(JSON.stringify(created)), { id: 47 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  assert.equal(calls[1].url, 'http://localhost:8000/api/tickets')
  assert.equal(calls[1].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].options.body), input)
  for (const { options } of calls) assert.equal(options.credentials, 'include')
  assert.equal(calls[1].options.headers.get('X-XSRF-TOKEN'), 'csrf test')
})

test('HTTP 201 com ID inválido confirma criação sem permitir inferir outro chamado', async () => {
  let payload = {}
  let posts = 0
  const load = runtime(async url => {
    if (url.endsWith('/sanctum/csrf-cookie')) return new Response(null, { status: 204 })
    posts++
    return json(payload, 201)
  })
  const { createTicket, TicketCreationResponseError } = await load('services/tickets')
  for (const id of [undefined, null, 0, -1, 1.5, '47', 9007199254740992]) {
    payload = { id }
    await assert.rejects(createTicket(input), error => {
      assert.ok(error instanceof TicketCreationResponseError)
      assert.match(error.message, /chamado foi criado/)
      return true
    })
  }
  assert.equal(posts, 7)
})

for (const status of [200, 202, 204, 205]) {
  test(`HTTP ${status} não confirma a criação`, async () => {
    const load = runtime(async (url) => url.endsWith('/sanctum/csrf-cookie')
      ? new Response(null, { status: 204 })
      : status >= 204 ? new Response(null, { status }) : json({}, status))
    const { createTicket } = await load('services/tickets')
    await assert.rejects(createTicket(input), /não confirmou/)
  })
}

for (const status of [401, 403, 419, 422, 503]) {
  test(`HTTP ${status} preserva o erro e apresenta mensagem`, async () => {
    const load = runtime(async (url) => url.endsWith('/sanctum/csrf-cookie')
      ? new Response(null, { status: 204 })
      : json({ errors: { category_id: ['Selecione uma categoria disponível.'] } }, status))
    const { createTicket, getCreateTicketErrorMessage } = await load('services/tickets')
    await assert.rejects(createTicket(input), (error) => {
      assert.equal(error.status, status)
      assert.ok(getCreateTicketErrorMessage(error).length > 0)
      if (status === 422) assert.equal(error.validationErrors.category_id[0], 'Selecione uma categoria disponível.')
      return true
    })
  })
}

test('falha de CSRF impede o POST; falha de rede não confirma sucesso', async () => {
  let requests = 0
  const load = runtime(async () => { requests++; throw new TypeError('offline') })
  const { createTicket, getCreateTicketErrorMessage } = await load('services/tickets')
  await assert.rejects(createTicket(input), (error) => {
    assert.match(getCreateTicketErrorMessage(error), /conexão/)
    return true
  })
  assert.equal(requests, 1)
})

test('categorias: consulta autenticada, lista vazia, projeção e contrato inválido', async () => {
  let payload = { data: [] }
  const load = runtime(async (url, options) => {
    assert.equal(url, 'http://localhost:8000/api/categories')
    assert.equal(options.credentials, 'include')
    return json(payload)
  })
  const { getCategories } = await load('services/categories')
  assert.equal((await getCategories()).length, 0)
  payload = { data: [{ id: 4, name: 'Acesso', description: 'Não exibir' }] }
  assert.equal(JSON.stringify(await getCategories()), JSON.stringify([{ id: 4, name: 'Acesso' }]))
  payload = { data: [{ id: '4', name: 'Acesso' }] }
  await assert.rejects(getCategories(), /formato esperado/)
})

test('validação: obrigatórios, espaços, limite, categoria real e códigos de prioridade', async () => {
  const load = runtime(() => { throw new Error('A validação não deve consultar a rede') })
  const { validateTicketForm } = await load('utils/ticket-form')
  const categories = [{ id: 4, name: 'Acesso' }]
  const empty = validateTicketForm({ title: ' ', description: '\n', category_id: '', priority: '' }, categories)
  assert.deepEqual(Object.keys(empty), ['title', 'description', 'category_id', 'priority'])
  const values = { title: 'á'.repeat(255), description: 'ç'.repeat(10000), category_id: '4', priority: 'medium' }
  assert.equal(Object.keys(validateTicketForm(values, categories)).length, 0)
  assert.equal(Object.keys(validateTicketForm({ ...values, title: `  ${values.title}  `, description: `\n${values.description}\t` }, categories)).length, 0)
  assert.ok(validateTicketForm({ ...values, title: 'á'.repeat(256) }, categories).title)
  assert.ok(validateTicketForm({ ...values, description: 'ç'.repeat(10001) }, categories).description)
  assert.ok(validateTicketForm({ ...values, category_id: '999' }, categories).category_id)
  assert.ok(validateTicketForm(values, []).category_id)
  assert.ok(validateTicketForm({ ...values, priority: 'critical' }, categories).priority)
  for (const priority of ['low', 'medium', 'high', 'urgent']) {
    assert.equal(Object.keys(validateTicketForm({ ...values, priority }, categories)).length, 0)
  }
})
