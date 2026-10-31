import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError, getAuthenticationGeneration } from '../services/api'
import { getCurrentUser } from '../services/auth'
import { getSettingsErrorMessage, updateOwnName } from '../services/settings'
import type { AuthenticatedUser } from '../types/auth'
import { normalizeAdminUserEditValues, validateAdminUserEditForm } from '../utils/admin-user-form'
import { roleLabels } from '../utils/user'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

export default function ProfileSettingsForm({ user, onUserUpdated }: { user: AuthenticatedUser; onUserUpdated: (user: AuthenticatedUser) => void }) {
  const [original, setOriginal] = useState(user)
  const [name, setName] = useState(user.name)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const generation = useRef(getAuthenticationGeneration())
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const alert = useRef<HTMLParagraphElement>(null)
  const focusError = useRef(false)
  const normalizedName = normalizeAdminUserEditValues({ name, email: '' }).name
  const changed = normalizedName !== original.name
  const isCurrent = () => mounted.current && generation.current === getAuthenticationGeneration()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controller.current?.abort() }
  }, [])
  useEffect(() => {
    if (pending || !focusError.current) return
    if (nameError) input.current?.focus()
    else alert.current?.focus()
    focusError.current = false
  }, [pending, error, nameError])

  async function refresh() {
    if (inProgress.current) return
    inProgress.current = true; setPending(true); setNotice(null)
    try {
      const current = await getCurrentUser()
      if (!isCurrent()) return
      if (current.id !== original.id) throw new Error('Identidade divergente')
      setOriginal(current); onUserUpdated(current)
      setError(null); setNameError(undefined); setNeedsRefresh(false)
      setNotice('Dados atualizados. Sua edição foi preservada. Confira o nome atual abaixo e revise antes de salvar.')
    } catch (cause) {
      if (isCurrent()) { setError(getSettingsErrorMessage(cause)); focusError.current = true }
    } finally {
      inProgress.current = false
      if (isCurrent()) setPending(false)
    }
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || needsRefresh || !changed) return
    const validation = validateAdminUserEditForm({ name }).name
    setNameError(validation); setError(null); setNotice(null)
    if (validation) { input.current?.focus(); return }
    inProgress.current = true; setPending(true)
    const request = new AbortController(); controller.current = request
    try {
      const current = await updateOwnName(normalizedName, original.name, request.signal)
      if (!isCurrent()) return
      if (current.id !== original.id) throw new Error('Identidade divergente')
      setOriginal(current); setName(current.name); onUserUpdated(current)
      setNotice('Nome atualizado com sucesso.')
    } catch (cause) {
      if (!isCurrent()) return
      setError(getSettingsErrorMessage(cause))
      if (cause instanceof ApiError && cause.status === 422) setNameError(cause.validationErrors.name?.join(' '))
      setNeedsRefresh(!(cause instanceof ApiError) || cause.status === 409 || cause.status >= 500 || Boolean(cause.validationErrors.expected_name?.length))
      focusError.current = true
    } finally {
      inProgress.current = false
      if (isCurrent()) setPending(false)
    }
  }

  return <section aria-labelledby="settings-profile-title" className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
    <h2 id="settings-profile-title" className="text-sm font-semibold text-[#263c57]">Meu perfil</h2>
    <p className="mt-2 text-xs leading-6 text-[#607189]">Atualize seu nome. E-mail e perfil são gerenciados pela administração.</p>
    <form id="settings-profile-form" noValidate aria-labelledby="settings-profile-title" aria-busy={pending} onSubmit={event => void submit(event)} className="mt-5 max-w-3xl space-y-5">
      {error && <p ref={alert} tabIndex={-1} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
      {notice && <div role="status" className="rounded-lg border border-[#dce6f3] bg-[#f4f8fe] p-3 text-sm leading-6 wrap-anywhere text-[#3d526d]"><p>{notice}</p>{notice.startsWith('Dados atualizados') && <p className="mt-2">Nome atual: {original.name}</p>}</div>}
      <div>
        <label htmlFor="settings-name" className="mb-2 block text-xs font-medium text-[#3d526d]">Nome completo <span aria-hidden="true">*</span></label>
        <input ref={input} id="settings-name" name="name" autoComplete="name" required maxLength={255} disabled={pending} value={name} onChange={event => { setName(event.target.value); setNameError(undefined); setNotice(null) }} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'settings-name-error' : undefined} className={fieldClass} />
        {nameError && <p id="settings-name-error" role="alert" className="mt-2 text-xs leading-5 text-red-700">{nameError}</p>}
      </div>
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div><label htmlFor="settings-email" className="mb-2 block text-xs font-medium text-[#3d526d]">E-mail (somente leitura)</label><input id="settings-email" type="email" autoComplete="email" value={original.email} readOnly className={`${fieldClass} bg-[#f5f7fa]`} /></div>
        <div><label htmlFor="settings-role" className="mb-2 block text-xs font-medium text-[#3d526d]">Perfil (somente leitura)</label><input id="settings-role" value={roleLabels[original.role]} readOnly className={`${fieldClass} bg-[#f5f7fa]`} /></div>
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        {needsRefresh && <button type="button" disabled={pending} onClick={() => void refresh()} className={buttonClass}>Atualizar dados</button>}
        <button type="submit" disabled={pending || needsRefresh || !changed} className={primaryButtonClass}>{pending ? 'Aguarde...' : 'Salvar nome'}</button>
      </div>
    </form>
  </section>
}
