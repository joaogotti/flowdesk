import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { getUpdateAdminUserStatusErrorMessage, updateAdminUserStatus } from '../services/admin-users'
import type { AdminUser } from '../types/admin-users'
import type { AuthenticatedUser } from '../types/auth'
import { canChangeAdminUserStatus } from '../utils/admin-user-status'
import { roleLabels } from '../utils/user'
import { buttonClass, primaryButtonClass } from './control-styles'

interface Props {
  user: AdminUser
  actor: AuthenticatedUser
  onCancel: () => void
  onRefresh: () => void
  onSaved: (user: AdminUser) => void
}

export default function UserStatusConfirmation({ user, actor, onCancel, onRefresh, onSaved }: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const alertRef = useRef<HTMLParagraphElement>(null)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  // The selected row is a snapshot; refreshing the list must not rebase this decision.
  const active = user.disabled_at === null
  const action = active ? 'Desativar' : 'Ativar'
  const eligible = canChangeAdminUserStatus(actor, user)

  useEffect(() => {
    mounted.current = true
    cancelButton.current?.focus()
    return () => { mounted.current = false }
  }, [])

  useEffect(() => { if (error) alertRef.current?.focus() }, [error])

  function cancel() { if (!inProgress.current) onCancel() }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || error || !eligible || !confirmed) return
    inProgress.current = true
    setPending(true)
    let updated: AdminUser
    try {
      updated = await updateAdminUserStatus(user.id, { is_active: !active, expected_is_active: active })
    } catch (cause) {
      inProgress.current = false
      if (!mounted.current) return
      setPending(false)
      setConfirmed(false)
      setError(getUpdateAdminUserStatusErrorMessage(cause))
      return
    }
    if (mounted.current) onSaved(updated)
  }

  return (
    <section id="user-status-panel" aria-labelledby="user-status-title" className="mb-6 min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id="user-status-title" className="text-sm font-semibold text-[#263c57]">{action} usuário</h2>
      <p id="user-status-description" className="mt-2 text-xs leading-6 wrap-anywhere text-[#607189]">Usuário: {user.name} · {user.email}.</p>
      <p className="mt-2 text-sm text-[#3d526d]">Perfil: <strong>{roleLabels[user.role]}</strong> · Situação atual: <strong>{active ? 'Ativo' : 'Desativado'}</strong></p>
      <form aria-labelledby="user-status-title" aria-describedby="user-status-description user-status-consequences" aria-busy={pending} onSubmit={event => void submit(event)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-5 max-w-3xl space-y-5">
        {!eligible && <p role="alert" className="text-sm text-red-800">Não é permitido alterar a situação da própria conta.</p>}
        {error && <p ref={alertRef} tabIndex={-1} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        <div id="user-status-consequences" className="rounded-lg border border-[#dce6f3] bg-[#f4f8fe] px-4 py-3 text-sm leading-6 text-[#3d526d]">
          <p>{active ? 'A desativação bloqueia o acesso e revoga as sessões deste usuário.' : 'A ativação permite novos acessos. As sessões antigas permanecem revogadas; o usuário precisará entrar novamente.'}</p>
          <p className="mt-2">Os chamados, responsáveis e históricos serão preservados, sem redistribuição automática.</p>
          {active && user.role === 'technician' && <p className="mt-2">Técnicos com chamados abertos, em andamento, aguardando solicitante ou resolvidos não podem ser desativados.</p>}
        </div>
        <label htmlFor="user-status-confirm" className="flex items-start gap-3 text-sm leading-6 wrap-anywhere text-[#3d526d]">
          <input id="user-status-confirm" type="checkbox" checked={confirmed} disabled={pending || Boolean(error) || !eligible} onChange={event => setConfirmed(event.target.checked)} className="mt-1 size-4 shrink-0 accent-[#2864db] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2864db]" />
          <span>Confirmo que desejo {action.toLowerCase()} este usuário.</span>
        </label>
        {pending && <p role="status" className="text-sm text-[#607189]">Alterando situação...</p>}
        <div className="flex flex-wrap justify-end gap-3">
          {error && <button type="button" disabled={pending} onClick={() => { if (!inProgress.current) onRefresh() }} className={buttonClass}>Atualizar dados</button>}
          <button ref={cancelButton} type="button" disabled={pending} onClick={cancel} className={buttonClass}>Cancelar</button>
          <button type="submit" disabled={pending || Boolean(error) || !eligible || !confirmed} className={primaryButtonClass}>{pending ? 'Aguarde...' : 'Confirmar'}</button>
        </div>
        {error && <p className="text-xs leading-6 text-[#607189]">Atualize os dados e abra novamente a confirmação para conferir a situação atual antes de tentar outra vez.</p>}
      </form>
    </section>
  )
}
