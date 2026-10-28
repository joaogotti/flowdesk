import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError } from '../services/api'
import { getUpdateAdminUserRoleErrorMessage, updateAdminUserRole } from '../services/admin-users'
import type { AdminUser } from '../types/admin-users'
import type { AuthenticatedUser, UserRole } from '../types/auth'
import { canChangeAdminUserRole, isUserRole, userRoleConsequences } from '../utils/admin-user-role'
import { roleLabels } from '../utils/user'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

interface Props {
  user: AdminUser
  actor: AuthenticatedUser
  onCancel: () => void
  onRefresh: () => void
  onSaved: (user: AdminUser) => void
}

export default function UserRoleForm({ user, actor, onCancel, onRefresh, onSaved }: Props) {
  const [role, setRole] = useState<UserRole>(user.role)
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)
  const roleInput = useRef<HTMLSelectElement>(null)
  const alertRef = useRef<HTMLParagraphElement>(null)
  const focusError = useRef(false)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const eligible = canChangeAdminUserRole(actor, user)
  const changed = role !== user.role

  useEffect(() => {
    mounted.current = true
    roleInput.current?.focus()
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (pending || !focusError.current) return
    focusError.current = false
    if (roleError) roleInput.current?.focus()
    else alertRef.current?.focus()
  }, [error, roleError, pending])

  function cancel() { if (!inProgress.current) onCancel() }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || needsRefresh || !eligible || !changed || !confirmed) return
    if (!isUserRole(role)) {
      setRoleError('Selecione Solicitante, Técnico ou Administrador.')
      roleInput.current?.focus()
      return
    }
    inProgress.current = true
    setPending(true)
    setError(null)
    setRoleError(null)
    let updated: AdminUser
    try {
      // user is the snapshot selected when this panel opened; list refreshes do not rebase it.
      updated = await updateAdminUserRole(user.id, { role, expected_role: user.role })
    } catch (cause) {
      inProgress.current = false
      if (!mounted.current) return
      setPending(false)
      setConfirmed(false)
      setError(getUpdateAdminUserRoleErrorMessage(cause))
      const validation = cause instanceof ApiError && cause.status === 422
      setNeedsRefresh(!validation || Boolean(cause.validationErrors.expected_role?.length))
      if (validation && cause.validationErrors.role?.length) setRoleError('Selecione um perfil válido.')
      focusError.current = true
      return
    }
    if (mounted.current) onSaved(updated)
  }

  return (
    <section id="user-role-panel" aria-labelledby="user-role-title" className="mb-6 min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id="user-role-title" className="text-sm font-semibold text-[#263c57]">Alterar perfil</h2>
      <p id="user-role-description" className="mt-2 text-xs leading-6 wrap-anywhere text-[#607189]">Usuário: {user.name} · {user.email}.</p>
      <p className="mt-2 text-sm text-[#3d526d]">Perfil atual: <strong>{roleLabels[user.role]}</strong></p>
      <form noValidate aria-labelledby="user-role-title" aria-describedby="user-role-description user-role-consequences user-role-warning" aria-busy={pending} onSubmit={event => void submit(event)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-5 max-w-3xl space-y-5">
        {!eligible && <p role="alert" className="text-sm text-red-800">Não é permitido alterar o próprio perfil ou o perfil de uma conta desativada.</p>}
        {error && <p ref={alertRef} tabIndex={-1} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        <div className="min-w-0 sm:max-w-sm">
          <label htmlFor="user-role-next" className="mb-2 block text-xs font-medium text-[#3d526d]">Novo perfil</label>
          <select ref={roleInput} id="user-role-next" name="role" required value={role} disabled={pending || needsRefresh || !eligible} aria-invalid={Boolean(roleError)} aria-describedby={roleError ? 'user-role-error' : 'user-role-consequences'} onChange={event => { setRole(event.target.value as UserRole); setConfirmed(false); setRoleError(null) }} className={fieldClass}>
            {(['requester', 'technician', 'admin'] as const).map(value => <option key={value} value={value}>{roleLabels[value]}</option>)}
          </select>
          {roleError && <p id="user-role-error" role="alert" className="mt-2 text-xs leading-5 text-red-700">{roleError}</p>}
        </div>
        <div id="user-role-consequences" className="rounded-lg border border-[#dce6f3] bg-[#f4f8fe] px-4 py-3 text-sm leading-6 text-[#3d526d]">
          <p>A mudança de perfil altera as permissões de acesso.</p>
          {changed && isUserRole(role) && <p className="mt-2">{userRoleConsequences[role]}</p>}
          <p className="mt-2">Os chamados existentes serão preservados. Nenhum responsável será transferido ou removido automaticamente.</p>
        </div>
        <p id="user-role-warning" className="text-xs leading-6 text-[#607189]">Técnicos com chamados abertos, em andamento, aguardando solicitante ou resolvidos não podem sair do perfil técnico.</p>
        {!changed && <p role="status" className="text-xs leading-6 text-[#607189]">Selecione um perfil diferente do atual para continuar.</p>}
        <label htmlFor="user-role-confirm" className="flex items-start gap-3 text-sm leading-6 wrap-anywhere text-[#3d526d]">
          <input id="user-role-confirm" type="checkbox" checked={confirmed} disabled={pending || needsRefresh || !eligible || !changed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 size-4 shrink-0 accent-[#2864db] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2864db]" />
          <span>{changed ? `Confirmo a alteração de ${roleLabels[user.role]} para ${roleLabels[role] ?? 'o perfil selecionado'} deste usuário.` : 'Confirmo a alteração das permissões deste usuário.'}</span>
        </label>
        <div className="flex flex-wrap justify-end gap-3">
          {error && <button type="button" disabled={pending} onClick={() => { if (!inProgress.current) onRefresh() }} className={buttonClass}>Atualizar dados</button>}
          <button type="button" disabled={pending} onClick={cancel} className={buttonClass}>Cancelar</button>
          <button type="submit" disabled={pending || needsRefresh || !eligible || !changed || !confirmed} className={primaryButtonClass}>{pending ? 'Alterando perfil...' : 'Confirmar'}</button>
        </div>
        {needsRefresh && <p className="text-xs leading-6 text-[#607189]">Atualize os dados e abra novamente a alteração para conferir o perfil atual antes de confirmar.</p>}
      </form>
    </section>
  )
}
