import assert from 'node:assert/strict'
import test from 'node:test'
import { runtime } from './helpers/runtime.mjs'

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

test('histórico: todas as transições, traduções e referências sem nome', async () => {
  const { parseTicketActivityDetails, getTicketActivityEntries } = await runtime()('utils/ticket-history')
  for (const [action, details, expected] of [
    ['assignment_changed', { assignee: { from: null, to: { id: 8, name: 'Técnico' } } }, ['Responsável alterado — Não atribuído → Técnico']],
    ['assignment_changed', { assignee: { from: { id: 8, name: 'Técnico' }, to: null } }, ['Responsável alterado — Técnico → Não atribuído']],
    ['assignment_changed', { assignee: { from: { id: 8, name: null }, to: { id: 9 } } }, ['Responsável alterado — Usuário #8 → Usuário #9']],
    ['status_changed', { status: { from: 'open', to: 'in_progress' } }, ['Status alterado — Aberto → Em andamento']],
    ['status_changed', { status: { from: 'waiting_requester', to: 'resolved' } }, ['Status alterado — Aguardando solicitante → Resolvido']],
    ['status_changed', { status: { from: 'closed', to: 'cancelled' } }, ['Status alterado — Fechado → Cancelado']],
    ['details_changed', { category: { from: { id: 3, name: 'Rede' }, to: { id: 1, name: 'Hardware' } }, priority: { from: 'medium', to: 'high' } }, ['Categoria alterada — Rede → Hardware', 'Prioridade alterada — Média → Alta']],
    ['details_changed', { category: { from: { id: 99, name: null }, to: { id: 1, name: '  ' } } }, ['Categoria alterada — Categoria #99 → Categoria #1']],
    ['details_changed', { priority: { from: 'low', to: 'urgent' } }, ['Prioridade alterada — Baixa → Crítica']],
    ['assignment_changed', { assignee: { to: null } }, ['Responsável alterado — Não informado → Não atribuído']],
    ['status_changed', { status: { from: null, to: 'in_progress' } }, ['Status alterado — Não informado → Em andamento']],
    ['details_changed', { category: { to: null }, priority: { from: 'medium' } }, ['Categoria alterada — Não informado → Não informado', 'Prioridade alterada — Média → Não informado']],
  ]) {
    const parsed = parseTicketActivityDetails(action, details)
    assert.deepEqual(plain(getTicketActivityEntries({ action, details: parsed }).map(({title, transition})=>transition === undefined ? title : `${title} — ${transition}`)), expected)
  }
})

test('histórico: projeção por ação e lado elimina metadados sem perder null explícito', async () => {
  const { parseTicketActivityDetails } = await runtime()('utils/ticket-history')
  assert.deepEqual(plain(parseTicketActivityDetails('assignment_changed', {
    assignee: { to: null, body: 'privado' }, priority: { from: 'low', to: 'high' }, changes: { secret: true },
  })), { assignee: { to: null } })
  assert.deepEqual(plain(parseTicketActivityDetails('details_changed', {
    category: { from: { id: 1, name: 'Nome', email: 'privado' }, to: { id: 2, name: ['inválido'] } },
    priority: { from: 'constructor', to: 'high', private: 'privado' }, assignee: { from: null, to: null },
  })), { category: { from: { id: 1, name: 'Nome' } }, priority: { to: 'high' } })
})

test('histórico: dados inválidos e eventos antigos mantêm os rótulos genéricos', async () => {
  const { parseTicketActivityDetails, getTicketActivityEntries } = await runtime()('utils/ticket-history')
  for (const action of ['created', 'ticket_created', 'comment_added', 'future_action']) {
    assert.equal(parseTicketActivityDetails(action, { assignee: { from: null, to: null }, body: 'privado' }), undefined)
  }
  for (const details of [undefined, null, false, 1, 'privado', [], {}, { assignee: [] }, { assignee: 'privado' },
    { assignee: { from: { id: 0, name: 'Inválido' }, to: { id: '8', name: 'Inválido' } } },
    { assignee: { from: true, to: { id: Number.MAX_SAFE_INTEGER + 1, name: 'Inválido' } } }]) {
    assert.equal(parseTicketActivityDetails('assignment_changed', details), undefined)
  }
  for (const [action, label] of [['created', 'Chamado criado'], ['ticket_created', 'Chamado criado'], ['comment_added', 'Comentário adicionado'],
    ['assignment_changed', 'Responsável alterado'], ['status_changed', 'Status alterado'], ['details_changed', 'Informações alteradas'], ['future_action', 'future_action']]) {
    assert.deepEqual(plain(getTicketActivityEntries({ action })), [{ title: label }])
  }
})
