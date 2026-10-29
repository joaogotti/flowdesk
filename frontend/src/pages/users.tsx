import { useEffect, useRef, useState } from 'react'
import { buttonClass, fieldClass, primaryButtonClass } from '../components/control-styles'
import UserCreateForm from '../components/user-create-form'
import UserEditForm from '../components/user-edit-form'
import UserRoleForm from '../components/user-role-form'
import UserStatusConfirmation from '../components/user-status-confirmation'
import TicketDate from '../components/ticket-date'
import { getAdminUsers, getAdminUsersErrorMessage } from '../services/admin-users'
import type { AdminUser, AdminUserFilters, AdminUsersResponse } from '../types/admin-users'
import type { AuthenticatedUser, UserRole } from '../types/auth'
import { roleLabels } from '../utils/user'
import { canChangeAdminUserRole } from '../utils/admin-user-role'
import { canChangeAdminUserStatus } from '../utils/admin-user-status'

const initialFilters: AdminUserFilters = { search: '', role: '', status: '', page: 1, per_page: 15 }

interface ListResult {
  key: string
  response: AdminUsersResponse | null
  error: string | null
}

export default function Users({ user, onUserUpdated }: { user: AuthenticatedUser; onUserUpdated?: (user: AdminUser) => void }) {
  if (user.role !== 'admin') {
    return (
      <div role="alert" className="rounded-xl border border-[#e0e6ee] bg-white p-6">
        <h1 className="text-xl font-semibold text-[#172b45]">Acesso não permitido</h1>
        <p className="mt-3 text-sm leading-6 text-[#607189]">Somente administradores podem consultar os usuários cadastrados.</p>
        <a href="#/visao-geral" className={`${buttonClass} mt-5`}>Voltar à Visão geral</a>
      </div>
    )
  }
  return <UsersList actor={user} onUserUpdated={onUserUpdated} />
}

function UsersList({ actor, onUserUpdated }: { actor: AuthenticatedUser; onUserUpdated?: (user: AdminUser) => void }) {
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [changingRole, setChangingRole] = useState<AdminUser | null>(null)
  const [changingStatus, setChangingStatus] = useState<AdminUser | null>(null)
  const [statusUpdated, setStatusUpdated] = useState<string | null>(null)
  const [roleUpdated, setRoleUpdated] = useState(false)
  const [updated, setUpdated] = useState(false)
  const [created, setCreated] = useState<AdminUser | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const editButtons = useRef(new Map<number, HTMLButtonElement>())
  const roleButtons = useRef(new Map<number, HTMLButtonElement>())
  const roleFocus = useRef<number | null>(null)
  const statusButtons = useRef(new Map<number, HTMLButtonElement>())
  const statusFocus = useRef<number | null>(null)
  const editFocus = useRef<number | null>(null)
  const reconcileEditPage = useRef(false)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const restoreCreateFocus = useRef(false)
  const [filters, setFilters] = useState(initialFilters)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<ListResult | null>(null)
  const requestKey = JSON.stringify([filters, attempt])
  const loading = result?.key !== requestKey
  const response = !loading ? result?.response : null
  const error = !loading ? result?.error : null
  const hasFilters = Boolean(filters.search.trim() || filters.role || filters.status)

  useEffect(() => {
    if (!creating && restoreCreateFocus.current) {
      restoreCreateFocus.current = false
      createButton.current?.focus({ preventScroll: true })
    }
  }, [creating])

  useEffect(() => {
    if (editing || loading || editFocus.current === null) return
    const target = editButtons.current.get(editFocus.current) ?? retryButton.current ?? listHeading.current
    editFocus.current = null
    target?.focus({ preventScroll: true })
  }, [editing, loading, response])

  useEffect(() => {
    if (changingRole || loading || roleFocus.current === null) return
    const target = roleButtons.current.get(roleFocus.current) ?? editButtons.current.get(roleFocus.current) ?? retryButton.current ?? listHeading.current
    if (response) roleFocus.current = null
    target?.focus({ preventScroll: true })
  }, [changingRole, loading, response])

  useEffect(() => {
    if (changingStatus || loading || statusFocus.current === null) return
    const target = statusButtons.current.get(statusFocus.current) ?? retryButton.current ?? listHeading.current
    if (response) statusFocus.current = null
    target?.focus({ preventScroll: true })
  }, [changingStatus, loading, response])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getAdminUsers(filters, controller.signal)
        .then(data => {
          if (controller.signal.aborted) return
          if (reconcileEditPage.current && data.current_page > data.last_page) {
            setFilters(current => ({ ...current, page: data.last_page }))
            return
          }
          reconcileEditPage.current = false
          setResult({ key: requestKey, response: data, error: null })
        })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setResult({ key: requestKey, response: null, error: getAdminUsersErrorMessage(cause) }) })
    }, filters.search.trim() ? 400 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [filters, requestKey])

  function updateFilters(update: Partial<AdminUserFilters>) {
    setFilters(current => ({ ...current, ...update, page: 1 }))
  }

  function closeForm() {
    restoreCreateFocus.current = true
    setCreating(false)
  }

  function closeEditor() {
    editFocus.current = editing?.id ?? null
    setEditing(null)
  }

  function closeRoleForm(refresh = false) {
    roleFocus.current = changingRole?.id ?? null
    setChangingRole(null)
    if (refresh) {
      reconcileEditPage.current = true
      setAttempt(value => value + 1)
    }
  }

  function closeStatusForm(refresh = false) {
    statusFocus.current = changingStatus?.id ?? null
    setChangingStatus(null)
    if (refresh) {
      reconcileEditPage.current = true
      setAttempt(value => value + 1)
    }
  }

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
        <p className="mb-2.5 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">ADMINISTRAÇÃO</p>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.035em] text-[#172b45] sm:text-[32px]">Usuários</h1>
        <p className="mt-2.5 text-[13px] leading-6 text-[#607189]">Consulte os usuários cadastrados, seus perfis e a situação das contas.</p>
        </div>
        <button ref={createButton} type="button" disabled={creating || editing !== null || changingRole !== null || changingStatus !== null} aria-expanded={creating} aria-controls={creating ? 'user-create-panel' : undefined} onClick={() => { setCreated(null); setUpdated(false); setRoleUpdated(false); setStatusUpdated(null); setCreating(true) }} className={primaryButtonClass}>Novo usuário</button>
      </div>
      {roleUpdated && <p role="status" className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">Perfil alterado com sucesso. Os filtros atuais foram preservados.</p>}
      {statusUpdated && <p role="status" className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{statusUpdated} Os filtros atuais foram preservados.</p>}
      {updated && <p role="status" className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">Usuário alterado com sucesso. Os filtros atuais foram preservados.</p>}
      {created && <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p role="status" className="text-sm text-emerald-800">Usuário cadastrado com sucesso. Os filtros atuais foram preservados.</p>
        <button type="button" onClick={() => { updateFilters({ search: created.email, role: '', status: '' }); setAttempt(value => value + 1) }} className={buttonClass}>Localizar usuário cadastrado</button>
      </div>}
      {creating && <UserCreateForm onCancel={closeForm} onCreated={user => { closeForm(); setCreated(user); setAttempt(value => value + 1) }} />}
      {editing && <UserEditForm key={editing.id} user={editing} onCancel={closeEditor} onSaved={user => {
        closeEditor()
        setUpdated(true)
        reconcileEditPage.current = true
        setAttempt(value => value + 1)
        onUserUpdated?.(user)
      }} />}
      {changingRole && <UserRoleForm key={changingRole.id} user={changingRole} actor={actor} onCancel={() => closeRoleForm()} onRefresh={() => closeRoleForm(true)} onSaved={() => {
        closeRoleForm(true)
        setRoleUpdated(true)
      }} />}
      {changingStatus && <UserStatusConfirmation key={changingStatus.id} user={changingStatus} actor={actor} onCancel={() => closeStatusForm()} onRefresh={() => closeStatusForm(true)} onSaved={user => {
        closeStatusForm(true)
        setStatusUpdated(user.disabled_at === null ? 'Usuário ativado com sucesso.' : 'Usuário desativado com sucesso.')
      }} />}
      <section aria-label="Filtros de usuários" className="mb-6 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
        <div className="grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="sm:col-span-2 xl:col-span-1">
            <label htmlFor="user-search" className="mb-2 block text-xs font-medium text-[#3d526d]">Pesquisar usuários</label>
            <input id="user-search" type="search" maxLength={255} value={filters.search} onChange={event => updateFilters({ search: event.target.value })} placeholder="Pesquisar por nome ou e-mail" className={fieldClass} />
          </div>
          <div>
            <label htmlFor="user-role" className="mb-2 block text-xs font-medium text-[#3d526d]">Perfil</label>
            <select id="user-role" value={filters.role} onChange={event => updateFilters({ role: event.target.value as UserRole | '' })} className={fieldClass}>
              <option value="">Todos</option>
              {(['admin', 'technician', 'requester'] as const).map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="user-status" className="mb-2 block text-xs font-medium text-[#3d526d]">Situação</label>
            <select id="user-status" value={filters.status} onChange={event => updateFilters({ status: event.target.value as AdminUserFilters['status'] })} className={fieldClass}>
              <option value="">Todos</option><option value="active">Ativos</option><option value="disabled">Desativados</option>
            </select>
          </div>
          <button type="button" disabled={!hasFilters} onClick={() => setFilters(initialFilters)} className={`${buttonClass} min-h-11`}>Limpar filtros</button>
        </div>
      </section>
      <section aria-labelledby="users-title" aria-busy={loading} className="min-w-0 overflow-hidden rounded-xl border border-[#e0e6ee] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-6">
          <h2 ref={listHeading} tabIndex={-1} id="users-title" className="text-sm font-semibold text-[#263c57] focus-visible:outline-2 focus-visible:outline-[#2864db]">Lista de usuários</h2>
          <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)} className={buttonClass}>Atualizar lista</button>
        </div>
        {loading && <p role="status" className="border-t border-[#e9edf3] px-6 py-16 text-center text-sm text-[#607189]">Carregando usuários...</p>}
        {error && <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800 sm:m-6">
          <p className="leading-6">{error}</p>
          <button ref={retryButton} type="button" onClick={() => setAttempt(value => value + 1)} className={`${buttonClass} mt-4`}>Tentar novamente</button>
        </div>}
        {response && <>
          {response.data.length ? (
            <div role="region" aria-label="Tabela de usuários, role horizontalmente para ver todas as colunas" tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2864db]">
              <table className="w-full min-w-240 table-fixed border-collapse text-left text-xs">
                <caption className="sr-only">Usuários cadastrados, perfis e situação de acesso</caption>
                <thead className="border-y border-[#e9edf3] bg-[#fafbfd] text-[#607189]">
                  <tr>
                    <th scope="col" className="w-[20%] py-3.5 pr-4 pl-6 font-medium">Nome</th>
                    <th scope="col" className="w-[24%] px-4 py-3.5 font-medium">E-mail</th>
                    <th scope="col" className="w-[11%] px-4 py-3.5 font-medium">Perfil</th>
                    <th scope="col" className="w-[10%] px-4 py-3.5 font-medium">Situação</th>
                    <th scope="col" className="w-[14%] px-4 py-3.5 font-medium">Data de cadastro</th>
                    <th scope="col" className="w-[21%] py-3.5 pr-6 pl-4 font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#edf0f5]">
                  {response.data.map(user => <tr key={user.id} className="text-[#3d526d] hover:bg-[#fafbfd]">
                    <th scope="row" className="py-5 pr-4 pl-6 text-[13px] leading-6 font-medium wrap-anywhere text-[#263c57]">{user.name}</th>
                    <td className="px-4 py-5 wrap-anywhere">{user.email}</td>
                    <td className="px-4 py-5">{roleLabels[user.role]}</td>
                    <td className="px-4 py-5"><span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-medium ${user.disabled_at === null ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{user.disabled_at === null ? 'Ativo' : 'Desativado'}</span></td>
                    <td className="px-4 py-5 text-[11px] text-[#607189]">{user.created_at ? <TicketDate value={user.created_at} /> : 'Não informada'}</td>
                    <td className="py-5 pr-6 pl-4"><div className="flex flex-wrap gap-2">
                      <button ref={node => { if (node) editButtons.current.set(user.id, node); else editButtons.current.delete(user.id) }} type="button" disabled={creating || editing !== null || changingRole !== null || changingStatus !== null} aria-label={`Editar usuário ${user.name}`} aria-expanded={editing?.id === user.id} aria-controls={editing?.id === user.id ? 'user-edit-panel' : undefined} onClick={() => { setCreated(null); setUpdated(false); setRoleUpdated(false); setStatusUpdated(null); setEditing(user) }} className={buttonClass}>Editar</button>
                      {canChangeAdminUserRole(actor, user) && <button ref={node => { if (node) roleButtons.current.set(user.id, node); else roleButtons.current.delete(user.id) }} type="button" disabled={creating || editing !== null || changingRole !== null || changingStatus !== null} aria-label={`Alterar perfil de ${user.name}`} aria-expanded={changingRole?.id === user.id} aria-controls={changingRole?.id === user.id ? 'user-role-panel' : undefined} onClick={() => { if (canChangeAdminUserRole(actor, user)) { setCreated(null); setUpdated(false); setRoleUpdated(false); setStatusUpdated(null); setChangingRole(user) } }} className={`${buttonClass} whitespace-nowrap`}>Alterar perfil</button>}
                      {canChangeAdminUserStatus(actor, user) && <button ref={node => { if (node) statusButtons.current.set(user.id, node); else statusButtons.current.delete(user.id) }} type="button" disabled={creating || editing !== null || changingRole !== null || changingStatus !== null} aria-label={`${user.disabled_at === null ? 'Desativar' : 'Ativar'} usuário ${user.name}`} aria-expanded={changingStatus?.id === user.id} aria-controls={changingStatus?.id === user.id ? 'user-status-panel' : undefined} onClick={() => { if (canChangeAdminUserStatus(actor, user)) { setCreated(null); setUpdated(false); setRoleUpdated(false); setStatusUpdated(null); setChangingStatus({ ...user }) } }} className={`${buttonClass} whitespace-nowrap ${user.disabled_at === null ? 'text-amber-800' : 'text-emerald-800'}`}>{user.disabled_at === null ? 'Desativar' : 'Ativar'}</button>}
                    </div></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          ) : <div role="status" className="border-t border-[#e9edf3] px-6 py-16 text-center text-sm text-[#607189]">
            <p>{response.total > 0 ? 'Não há usuários nesta página.' : hasFilters ? 'Nenhum usuário encontrado.' : 'Nenhum usuário cadastrado.'}</p>
            {response.current_page > 1 && <button type="button" className={`${buttonClass} mt-4`} onClick={() => updateFilters({})}>Voltar à primeira página</button>}
          </div>}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#e9edf3] bg-[#fafbfd] px-5 py-4 sm:px-6">
            <p role="status" className="text-xs text-[#607189]">{response.from !== null && response.to !== null ? `${response.from}–${response.to} de ${response.total}` : response.total} {response.total === 1 ? 'usuário' : 'usuários'}</p>
            <nav aria-label="Paginação de usuários" className="flex flex-wrap items-center gap-3">
              <button type="button" className={buttonClass} disabled={response.prev_page_url === null} onClick={() => setFilters(current => ({ ...current, page: response.current_page - 1 }))}>Anterior</button>
              <span className="text-xs text-[#607189]">Página {response.current_page} de {response.last_page}</span>
              <button type="button" className={buttonClass} disabled={response.next_page_url === null} onClick={() => setFilters(current => ({ ...current, page: response.current_page + 1 }))}>Próxima</button>
            </nav>
          </div>
        </>}
      </section>
    </>
  )
}
