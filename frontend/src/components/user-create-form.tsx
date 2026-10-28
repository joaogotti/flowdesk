import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError } from '../services/api'
import { createAdminUser, getCreateAdminUserErrorMessage } from '../services/admin-users'
import type { AdminUser, AdminUserFormErrors, AdminUserFormValues, CreateAdminUserInput } from '../types/admin-users'
import { userPasswordHelp, validateAdminUserForm } from '../utils/admin-user-form'
import { roleLabels } from '../utils/user'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

const initialValues: AdminUserFormValues = { name: '', email: '', role: '', password: '', password_confirmation: '' }
const fields = [
  { name: 'name', label: 'Nome completo', type: 'text', autoComplete: 'name' },
  { name: 'email', label: 'E-mail', type: 'email', autoComplete: 'email' },
  { name: 'role', label: 'Perfil', type: 'select', autoComplete: 'off' },
  { name: 'password', label: 'Senha inicial', type: 'password', autoComplete: 'new-password' },
  { name: 'password_confirmation', label: 'Confirmar senha', type: 'password', autoComplete: 'new-password' },
] as const

export default function UserCreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (user: AdminUser) => void }) {
  const [values, setValues] = useState(initialValues)
  const [errors, setErrors] = useState<AdminUserFormErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [visible, setVisible] = useState({ password: false, password_confirmation: false })
  const inputs = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>())
  const alertRef = useRef<HTMLParagraphElement>(null)
  const errorFocus = useRef<string | null | undefined>(undefined)
  const inProgress = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    inputs.current.get('name')?.focus({ preventScroll: true })
    return () => { mounted.current = false }
  }, [])

  function cancel() { if (!inProgress.current) onCancel() }

  function focusErrors(next: AdminUserFormErrors) {
    errorFocus.current = fields.find(field => next[field.name])?.name ?? null
  }

  useEffect(() => {
    if (pending || errorFocus.current === undefined) return
    if (errorFocus.current === null) alertRef.current?.focus()
    else inputs.current.get(errorFocus.current)?.focus()
    errorFocus.current = undefined
  }, [errors, error, pending])

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current) return
    const validation = validateAdminUserForm(values)
    setErrors(validation)
    setError(null)
    if (Object.keys(validation).length) { focusErrors(validation); return }
    inProgress.current = true
    setPending(true)
    let created: AdminUser
    try {
      created = await createAdminUser({ ...values, role: values.role as CreateAdminUserInput['role'] })
    } catch (cause) {
      inProgress.current = false
      if (!mounted.current) return
      setPending(false)
      setError(getCreateAdminUserErrorMessage(cause))
      const next: AdminUserFormErrors = {}
      if (cause instanceof ApiError && cause.status === 422) {
        for (const { name } of fields) {
          let message = cause.validationErrors[name]?.join(' ')
          // Nunca exibir uma senha eventualmente refletida em uma resposta de validação.
          for (const secret of [values.password, values.password_confirmation]) {
            if (message && secret) message = message.replaceAll(secret, '[senha omitida]')
          }
          if (message) next[name] = message
        }
      }
      setErrors(next)
      focusErrors(next)
      return
    }
    if (mounted.current) {
      setValues(initialValues)
      setVisible({ password: false, password_confirmation: false })
      onCreated(created)
    }
  }

  return (
    <section id="user-create-panel" aria-labelledby="user-create-title" className="mb-6 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id="user-create-title" className="text-sm font-semibold text-[#263c57]">Novo usuário</h2>
      <p className="mt-2 text-xs leading-6 text-[#607189]">Cadastre uma conta ativa de Solicitante ou Técnico. Todos os campos são obrigatórios.</p>
      <form noValidate aria-labelledby="user-create-title" aria-busy={pending} onSubmit={event => void submit(event)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-5 max-w-3xl space-y-5">
        {error && <p ref={alertRef} tabIndex={-1} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          {fields.map(field => {
            const id = `user-create-${field.name}`
            const passwordField = field.name === 'password' || field.name === 'password_confirmation' ? field.name : null
            const describedBy = [field.name === 'password' ? 'user-password-help' : '', errors[field.name] ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
            const common = {
              id, name: field.name, required: true, disabled: pending, value: values[field.name],
              'aria-invalid': Boolean(errors[field.name]), 'aria-describedby': describedBy, className: `${fieldClass} min-w-0`,
            }
            return <div key={field.name} className={`min-w-0 ${field.name === 'role' ? 'sm:col-span-2 sm:max-w-sm' : ''}`}>
              <label htmlFor={id} className="mb-2 block text-xs font-medium text-[#3d526d]">{field.label} <span aria-hidden="true">*</span></label>
              {field.type === 'select' ? <select {...common} ref={node => { if (node) inputs.current.set(field.name, node); else inputs.current.delete(field.name) }} onChange={event => { setValues(current => ({ ...current, role: event.target.value as AdminUserFormValues['role'] })); setErrors(current => ({ ...current, role: undefined })) }}>
                <option value="">Selecione o perfil</option>{(['requester', 'technician'] as const).map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}
              </select> : <div className="flex min-w-0 items-center gap-2">
                <input {...common} ref={node => { if (node) inputs.current.set(field.name, node); else inputs.current.delete(field.name) }} type={passwordField && visible[passwordField] ? 'text' : field.type} autoComplete={field.autoComplete} maxLength={passwordField ? undefined : 255} onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setErrors(current => ({ ...current, [field.name]: undefined })) }} />
                {passwordField && <button type="button" disabled={pending} aria-label={`${visible[passwordField] ? 'Ocultar' : 'Mostrar'} ${field.label.toLowerCase()}`} aria-pressed={visible[passwordField]} aria-controls={id} onClick={() => setVisible(current => ({ ...current, [passwordField]: !current[passwordField] }))} className={`${buttonClass} shrink-0`}>{visible[passwordField] ? 'Ocultar' : 'Mostrar'}</button>}
              </div>}
              {field.name === 'password' && <p id="user-password-help" className="mt-2 text-xs leading-5 text-[#607189]">{userPasswordHelp}</p>}
              {errors[field.name] && <p id={`${id}-error`} role="alert" className="mt-2 text-xs leading-5 wrap-anywhere text-red-700">{errors[field.name]}</p>}
            </div>
          })}
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" disabled={pending} onClick={cancel} className={buttonClass}>Cancelar</button>
          <button type="submit" disabled={pending} className={primaryButtonClass}>{pending ? 'Cadastrando usuário...' : 'Cadastrar usuário'}</button>
        </div>
      </form>
    </section>
  )
}
