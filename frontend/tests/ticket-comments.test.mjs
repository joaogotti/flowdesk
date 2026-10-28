import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (data, status) => new Response(JSON.stringify(data), { status })

test('comentário usa cookies, CSRF, campos permitidos e mensagem sem espaços nas extremidades', async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : json({ id: 1 }, 201)
  })
  const { createTicketComment } = await load('services/tickets')
  await createTicketComment('8', { body: '  Mensagem\ncompleta  ', is_internal: false, user_id: 99, status: 'closed' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  const { url, options } = calls[1]
  assert.equal(url, 'http://localhost:8000/api/tickets/8/comments')
  assert.equal(options.method, 'POST')
  assert.equal(options.credentials, 'include')
  assert.equal(options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.deepEqual(JSON.parse(options.body), { body: 'Mensagem\ncompleta', is_internal: false })
})

test('comentário interno transmite booleano verdadeiro', async () => {
  const load = runtime(async (url, options) => {
    if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    assert.equal(JSON.parse(options.body).is_internal, true)
    return json({ id: 1 }, 201)
  })
  await (await load('services/tickets')).createTicketComment('8', { body: 'Interno', is_internal: true })
})

test('IDs inválidos são rejeitados antes de CSRF ou POST', async () => {
  let calls = 0
  const load = runtime(async () => { calls++; throw Error('Não deve acessar a rede') })
  await assert.rejects((await load('services/tickets')).createTicketComment('0', { body: 'Texto', is_internal: false }))
  assert.equal(calls, 0)
})

for (const status of [200, 202, 204]) {
  test(`HTTP ${status} não confirma envio`, async () => {
    const load = runtime(async (url) => url.endsWith('/csrf-cookie') || status === 204
      ? new Response(null, { status: 204 }) : json({}, status))
    await assert.rejects((await load('services/tickets')).createTicketComment('8', { body: 'Texto', is_internal: false }))
  })
}

for (const status of [401, 403, 404, 409, 419, 422, 500]) {
  test(`comentário trata HTTP ${status} sem repetir POST`, async () => {
    let posts = 0
    const load = runtime(async (url) => {
      if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
      posts++
      return json({ errors: { body: ['Mensagem inválida.'] } }, status)
    })
    const { createTicketComment, getTicketCommentErrorMessage } = await load('services/tickets')
    await assert.rejects(createTicketComment('8', { body: 'Texto', is_internal: false }), error => {
      assert.equal(error.status, status)
      assert.ok(getTicketCommentErrorMessage(error).length > 0)
      if (status === 422) assert.equal(error.validationErrors.body[0], 'Mensagem inválida.')
      return true
    })
    assert.equal(posts, 1)
  })
}

test('validação local cobre mensagem vazia, limite e caractere nulo', async () => {
  const { validateTicketComment, canCommentOnTicket } = await runtime(() => {})('utils/ticket-comment')
  for (const body of ['', ' \n\t ', 'x'.repeat(10001), '\0']) assert.ok(validateTicketComment(body))
  assert.equal(validateTicketComment('x'.repeat(10000)), null)
  for (const status of ['open', 'in_progress', 'waiting_requester']) assert.equal(canCommentOnTicket(status), true)
  for (const status of ['resolved', 'closed', 'cancelled', 'unknown']) assert.equal(canCommentOnTicket(status), false)
})
