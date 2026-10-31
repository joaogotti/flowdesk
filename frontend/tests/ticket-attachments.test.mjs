import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (data, status = 200) => new Response(JSON.stringify(data), { status })
const attachment = (overrides = {}) => ({
  id: 3, original_name: 'evidência.txt', mime_type: 'text/plain', size_bytes: 3,
  uploaded_by: { id: 9, name: 'Autor do arquivo' },
  created_at: '2026-10-29T20:00:00Z', confirmed_at: '2026-10-29T20:00:01Z', ...overrides,
})

test('listagem usa contrato real, cookies e whitelist sem caminhos privados', async () => {
  const load = runtime(async (url, options) => {
    assert.equal(url, 'http://localhost:8000/api/tickets/8/attachments')
    assert.equal(options.credentials, 'include')
    assert.equal(options.cache, 'no-store')
    return json({ data: [attachment({ storage_key: 'private/secret', sha256: 'secret' })] })
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await (await load('services/ticket-attachments')).getTicketAttachments('8'))), [attachment()])
})

test('upload multipart envia somente file, com cookies/CSRF e sem Content-Type manual', async () => {
  const calls = []
  const load = runtime(async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/csrf-cookie') ? new Response(null, { status: 204 }) : json({ data: attachment() }, 201)
  })
  const file = new File(['abc'], 'evidência.txt', { type: 'text/plain' })
  await (await load('services/ticket-attachments')).uploadTicketAttachment('8', file)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://localhost:8000/sanctum/csrf-cookie')
  const { options, url } = calls[1]
  assert.equal(url, 'http://localhost:8000/api/tickets/8/attachments')
  assert.equal(options.method, 'POST')
  assert.equal(options.credentials, 'include')
  assert.equal(options.headers.get('X-XSRF-TOKEN'), 'csrf test')
  assert.equal(options.headers.has('Content-Type'), false)
  assert.deepEqual([...options.body.keys()], ['file'])
  assert.equal(await options.body.get('file').text(), 'abc')
})

test('download binário autenticado verifica MIME e tamanho sem URL pública', async () => {
  const load = runtime(async (url, options) => {
    assert.equal(url, 'http://localhost:8000/api/tickets/8/attachments/3/download')
    assert.equal(options.credentials, 'include')
    assert.equal(options.cache, 'no-store')
    return new Response('abc', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  })
  assert.equal(await (await (await load('services/ticket-attachments')).getAttachmentBlob('8', attachment())).text(), 'abc')
})

for (const [type, content] of [['text/html', 'abc'], ['text/plain', 'ab'], ['application/pdf', 'abc']]) {
  test(`download rejeita conteúdo divergente: ${type}/${content.length}`, async () => {
    const load = runtime(async () => new Response(content, { headers: { 'Content-Type': type } }))
    await assert.rejects((await load('services/ticket-attachments')).getAttachmentBlob('8', attachment()))
  })
}

for (const overrides of [{ id: 0 }, { size_bytes: 5242881 }, { mime_type: 'text/html' }, { confirmed_at: null }, { original_name: '../secret.txt' }, { uploaded_by: null }, { created_at: 'invalid' }]) {
  test(`listagem rejeita metadados inválidos ${JSON.stringify(overrides)}`, async () => {
    const load = runtime(async () => json({ data: [attachment(overrides)] }))
    await assert.rejects((await load('services/ticket-attachments')).getTicketAttachments('8'))
  })
}

test('listagem rejeita IDs duplicados e mais de 10 anexos', async () => {
  for (const data of [[attachment(), attachment()], Array.from({ length: 11 }, (_, i) => attachment({ id: i + 1 }))]) {
    const load = runtime(async () => json({ data }))
    await assert.rejects((await load('services/ticket-attachments')).getTicketAttachments('8'))
  }
})

test('IDs inválidos e arquivos inválidos não fazem requisições', async () => {
  let calls = 0
  const services = await runtime(async () => { calls++; throw Error('Unexpected') })('services/ticket-attachments')
  for (const id of ['0', '../8', '8/download', '-1']) {
    await assert.rejects(services.getTicketAttachments(id))
    await assert.rejects(services.uploadTicketAttachment(id, new File(['abc'], 'ok.txt')))
    await assert.rejects(services.getAttachmentBlob(id, attachment()))
  }
  for (const file of [new File([], 'empty.txt'), new File(['x'], 'x.svg', { type: 'image/svg+xml' }), new File(['x'], 'x.png', { type: 'text/plain' })]) {
    await assert.rejects(services.uploadTicketAttachment('8', file))
  }
  assert.equal(calls, 0)
})

test('validação cobre os quatro formatos, limite exato, vazio, extensão e MIME', async () => {
  const { validateAttachmentFile, formatAttachmentSize, canUploadAttachment, canPreviewAttachment } = await runtime(() => {})('utils/ticket-attachments')
  for (const [ext, type] of [['jpg', 'image/jpeg'], ['JPEG', 'image/jpeg'], ['png', 'image/png'], ['pdf', 'application/pdf'], ['txt', 'text/plain']]) {
    assert.equal(validateAttachmentFile(new File(['abc'], `ok.${ext}`, { type })), null)
  }
  assert.equal(validateAttachmentFile(new File([new Uint8Array(5242880)], 'ok.txt')), null)
  assert.ok(validateAttachmentFile(new File([new Uint8Array(5242881)], 'big.txt')))
  assert.ok(validateAttachmentFile(null))
  assert.equal(formatAttachmentSize(3), '3 B')
  assert.equal(formatAttachmentSize(1024), '1 KiB')
  assert.equal(formatAttachmentSize(5242880), '5 MiB')
  for (const status of ['open', 'in_progress', 'waiting_requester']) assert.equal(canUploadAttachment(status), true)
  for (const status of ['resolved', 'closed', 'cancelled', 'unknown']) assert.equal(canUploadAttachment(status), false)
  assert.equal(canPreviewAttachment(attachment({ mime_type: 'application/pdf' })), false)
  for (const mime_type of ['text/plain', 'image/jpeg', 'image/png']) assert.equal(canPreviewAttachment(attachment({ mime_type })), true)
})

for (const [status, code, fragment] of [
  [401, undefined, 'sessão expirou'], [401, 'session_revoked', 'sessão foi revogada'],
  [403, undefined, 'permissão'], [404, undefined, 'não existe'],
  [409, 'ticket_not_writable', 'status atual'], [409, 'attachment_limit_reached', '25 MiB'],
  [409, 'attachment_reservation_expired', 'expirou'], [413, undefined, 'limite'],
  [419, undefined, 'validar sua sessão'], [422, undefined, 'Arquivo do teste inválido'],
  [429, undefined, '10 tentativas'], [503, 'attachment_unavailable', 'armazenamento'],
]) {
  test(`erros de upload HTTP ${status}/${code} sem repetição`, async () => {
    let posts = 0
    const load = runtime(async url => {
      if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
      posts++
      return json({ code, errors: { file: ['Arquivo do teste inválido.'] }, message: '/private/do-not-display' }, status)
    })
    const services = await load('services/ticket-attachments')
    await assert.rejects(services.uploadTicketAttachment('8', new File(['abc'], 'ok.txt')), cause => {
      assert.equal(cause.status, status)
      assert.ok(services.getAttachmentErrorMessage(cause).includes(fragment))
      assert.ok(!services.getAttachmentErrorMessage(cause).includes('/private'))
      return true
    })
    assert.equal(posts, 1)
  })
}

test('falha de rede não repete upload e orienta consultar a listagem', async () => {
  let posts = 0
  const load = runtime(async url => {
    if (url.endsWith('/csrf-cookie')) return new Response(null, { status: 204 })
    posts++; throw TypeError('Offline')
  })
  const services = await load('services/ticket-attachments')
  await assert.rejects(services.uploadTicketAttachment('8', new File(['abc'], 'ok.txt')), cause => {
    assert.match(services.getAttachmentErrorMessage(cause), /listagem antes de repetir/)
    return true
  })
  assert.equal(posts, 1)
})

test('resposta de sucesso inesperada não confirma upload', async () => {
  for (const status of [200, 202, 204]) {
    const load = runtime(async url => url.endsWith('/csrf-cookie') || status === 204
      ? new Response(null, { status: 204 }) : json({ data: attachment() }, status))
    await assert.rejects((await load('services/ticket-attachments')).uploadTicketAttachment('8', new File(['abc'], 'ok.txt')))
  }
})

test('download 401 session_revoked notifica identidade; 403 não provoca logout', async () => {
  let status = 403, events = 0
  const load = runtime(async () => json({ code: 'session_revoked' }, status))
  const api = await load('services/api')
  api.onSessionRevoked(() => events++)
  const service = await load('services/ticket-attachments')
  await assert.rejects(service.getAttachmentBlob('8', attachment()))
  assert.equal(events, 0)
  status = 401
  await assert.rejects(service.getAttachmentBlob('8', attachment()), cause => cause.code === 'session_revoked')
  assert.equal(events, 1)
})

test('resposta binária anterior à revogação não entrega conteúdo protegido', async () => {
  let release
  const load = runtime(async url => url.endsWith('/slow')
    ? new Promise(resolve => { release = resolve }) : json({ code: 'session_revoked' }, 401))
  const api = await load('services/api')
  const pending = api.apiBlobRequest('/slow')
  await assert.rejects(api.apiRequest('/user'))
  release(new Response('abc', { headers: { 'Content-Type': 'text/plain' } }))
  await assert.rejects(pending, cause => cause.name === 'ObsoleteRequestError')
})
