import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError } from '../services/api'
import { getAdminUsersErrorMessage, getUpdateAdminUserErrorMessage, updateAdminUser } from '../services/admin-users'
import type { AdminUser, AdminUserEditErrors, AdminUserEditValues } from '../types/admin-users'
import { getAdminUserChanges, validateAdminUserEditForm } from '../utils/admin-user-form'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

const fields = [
  { name: 'name', label: 'Nome completo', type: 'text', autoComplete: 'name' },
  { name: 'email', label: 'E-mail', type: 'email', autoComplete: 'email' },
] as const

interface Props {
  user: AdminUser
  onCancel: () => void
  onRefresh: (signal: AbortSignal) => Promise<AdminUser | null>
  onSaved: (user: AdminUser) => void
}

export default function UserEditForm({ user, onCancel, onRefresh, onSaved }: Props) {
  const [original, setOriginal] = useState<AdminUser>(() => ({ ...user }))
  const [values, setValues] = useState<AdminUserEditValues>({ name: user.name, email: user.email })
  const [errors, setErrors] = useState<AdminUserEditErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const refreshController = useRef<AbortController | null>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const alertRef = useRef<HTMLParagraphElement>(null)
  const errorFocus = useRef<string | null | undefined>(undefined)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const changed = Object.keys(getAdminUserChanges(original, values)).length > 0

  useEffect(() => {
    mounted.current = true
    inputs.current.get('name')?.focus()
    return () => { mounted.current = false; refreshController.current?.abort() }
  }, [])

  useEffect(() => {
    if (pending || errorFocus.current === undefined) return
    if (errorFocus.current === null) alertRef.current?.focus()
    else inputs.current.get(errorFocus.current)?.focus()
    errorFocus.current = undefined
  }, [errors, error, pending])

  useEffect(() => {
    if (notice && !pending) noticeRef.current?.focus()
  }, [notice, pending])

  function cancel() { if (!inProgress.current) onCancel() }

  async function refresh() {
    if (inProgress.current) return
    const controller = new AbortController()
    refreshController.current = controller
    inProgress.current = true
    setPending(true); setRefreshing(true); setNotice(null)
    const changes = getAdminUserChanges(original, values)
    try {
      const current = await onRefresh(controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (!current || current.id !== original.id) {
        setError('O usuário não está na página atual da lista. Sua edição foi preservada. Cancele e localize o usuário novamente para conferir os dados atuais.')
        setNeedsRefresh(true)
        errorFocus.current = null
        return
      }
      setOriginal({ ...current })
      setValues({ name: Object.hasOwn(changes, 'name') ? values.name : current.name, email: Object.hasOwn(changes, 'email') ? values.email : current.email })
      setErrors({}); setError(null); setNeedsRefresh(false)
      setNotice('Dados atualizados. Sua edição foi preservada nos campos alterados. Confira os valores atuais abaixo e revise antes de salvar.')
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return
      setError(getAdminUsersErrorMessage(cause))
      setNeedsRefresh(true)
      errorFocus.current = null
    } finally {
      if (refreshController.current === controller) refreshController.current = null
      inProgress.current = false
      if (mounted.current) { setPending(false); setRefreshing(false) }
    }
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || needsRefresh || !changed) return
    const validation = validateAdminUserEditForm(values)
    setErrors(validation)
    setError(null)
    setNotice(null)
    if (Object.keys(validation).length) {
      errorFocus.current = fields.find(field => validation[field.name])?.name
      return
    }
    inProgress.current = true
    setPending(true)
    let updated: AdminUser
    try {
      updated = await updateAdminUser(original.id, getAdminUserChanges(original, values))
    } catch (cause) {
      inProgress.current = false
      if (!mounted.current) return
      setPending(false)
      setError(getUpdateAdminUserErrorMessage(cause))
      setNeedsRefresh(cause instanceof ApiError && (cause.status === 409 || (cause.status === 422 && Boolean(cause.validationErrors.expected_name?.length || cause.validationErrors.expected_email?.length))))
      const next: AdminUserEditErrors = {}
      if (cause instanceof ApiError && cause.status === 422) {
        for (const { name } of fields) {
          const message = cause.validationErrors[name]?.join(' ')
          if (message) next[name] = message
        }
      }
      setErrors(next)
      errorFocus.current = fields.find(field => next[field.name])?.name ?? null
      return
    }
    if (mounted.current) onSaved(updated)
  }

  return (
    <section id="user-edit-panel" aria-labelledby="user-edit-title" className="mb-6 min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id="user-edit-title" className="text-sm font-semibold text-[#263c57]">Editar usuário</h2>
      <p id="user-edit-description" className="mt-2 text-xs leading-6 wrap-anywhere text-[#607189]">Editando: {original.name} · {original.email} · ID {original.id}.</p>
      <form noValidate aria-labelledby="user-edit-title" aria-describedby="user-edit-description" aria-busy={pending} onSubmit={event => void submit(event)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-5 max-w-3xl space-y-5">
        {error && <p ref={alertRef} tabIndex={-1} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        {notice && <div ref={noticeRef} tabIndex={-1} role="status" className="rounded-lg border border-[#dce6f3] bg-[#f4f8fe] p-3 text-sm leading-6 wrap-anywhere text-[#3d526d]"><p>{notice}</p><p className="mt-2">Nome atual: {original.name}</p><p>E-mail atual: {original.email}</p></div>}
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          {fields.map(field => {
            const id = `user-edit-${field.name}`
            return <div key={field.name} className="min-w-0">
              <label htmlFor={id} className="mb-2 block text-xs font-medium text-[#3d526d]">{field.label} <span aria-hidden="true">*</span></label>
              <input ref={node => { if (node) inputs.current.set(field.name, node); else inputs.current.delete(field.name) }} id={id} name={field.name} type={field.type} autoComplete={field.autoComplete} required maxLength={255} disabled={pending} value={values[field.name]} onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setErrors(current => ({ ...current, [field.name]: undefined })) }} aria-invalid={Boolean(errors[field.name])} aria-describedby={errors[field.name] ? `${id}-error` : undefined} className={`${fieldClass} min-w-0`} />
              {errors[field.name] && <p id={`${id}-error`} role="alert" className="mt-2 text-xs leading-5 wrap-anywhere text-red-700">{errors[field.name]}</p>}
            </div>
          })}
        </div>
        {!changed && <p role="status" className="text-xs leading-6 text-[#607189]">Nenhuma alteração para salvar.</p>}
        <div className="flex flex-wrap justify-end gap-3">
          {(needsRefresh || refreshing) && <button type="button" disabled={pending} onClick={() => void refresh()} className={buttonClass}>{refreshing ? 'Atualizando dados...' : 'Atualizar dados'}</button>}
          <button type="button" disabled={pending} onClick={cancel} className={buttonClass}>Cancelar</button>
          <button type="submit" disabled={pending || needsRefresh || !changed} className={primaryButtonClass}>{refreshing ? 'Aguarde a atualização' : pending ? 'Salvando alterações...' : 'Salvar alterações'}</button>
        </div>
      </form>
    </section>
  )
}
