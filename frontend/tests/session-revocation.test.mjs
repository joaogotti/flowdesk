import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('sessão: somente 401 session_revoked notifica a revogação; unsubscribe funciona', async () => {
  let response = json({ code: 'session_revoked' }, 403)
  const { apiRequest, onSessionRevoked } = await runtime(async () => response)('services/api')
  let revoked = 0
  const unsubscribe = onSessionRevoked(() => revoked++)
  for (const status of [403, 401, 419, 409]) {
    response = json({ code: status === 401 ? 'other' : 'session_revoked' }, status)
    await assert.rejects(apiRequest('/user'))
    assert.equal(revoked, 0)
  }
  response = json({ code: 'session_revoked' }, 401)
  await assert.rejects(apiRequest('/user'), cause => cause.code === 'session_revoked' && cause.status === 401)
  assert.equal(revoked, 1)
  unsubscribe()
  response = json({ code: 'session_revoked' }, 401)
  await assert.rejects(apiRequest('/user'))
  assert.equal(revoked, 1)
})

for (const status of [200, 204]) test(`sessão: resposta ${status} atrasada não recupera dados após revogação`, async () => {
  let finish
  const { apiRequest } = await runtime(async url => new URL(url).pathname.endsWith('/slow')
    ? new Promise(resolve => { finish = resolve })
    : json({ code: 'session_revoked' }, 401))('services/api')
  const old = apiRequest('/slow')
  await assert.rejects(apiRequest('/user'))
  finish(status === 204 ? new Response(null, { status }) : json({ id: 8, name: 'Pessoa' }))
  await assert.rejects(old, cause => cause.name === 'ObsoleteRequestError')
})
