import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError, getAuthenticationGeneration } from '../services/api'
import { changeOwnPassword, getSettingsErrorMessage } from '../services/settings'
import type { PasswordChangeInput } from '../services/settings'
import { userPasswordHelp } from '../utils/admin-user-form'
import { validatePasswordChange } from '../utils/settings-form'
import type { PasswordChangeErrors } from '../utils/settings-form'
import { fieldClass, primaryButtonClass } from './control-styles'

const fields = [
  { name: 'current_password', label: 'Senha atual', autoComplete: 'current-password' },
  { name: 'password', label: 'Nova senha', autoComplete: 'new-password' },
  { name: 'password_confirmation', label: 'Confirmar nova senha', autoComplete: 'new-password' },
] as const

export default function PasswordSettingsForm() {
  const [errors, setErrors] = useState<PasswordChangeErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const alert = useRef<HTMLParagraphElement>(null)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const generation = useRef(getAuthenticationGeneration())
  const controller = useRef<AbortController | null>(null)
  const focusError = useRef(false)

  useEffect(() => {
    mounted.current = true
    const element = form.current
    return () => { mounted.current = false; controller.current?.abort(); element?.reset() }
  }, [])
  useEffect(() => {
    if (pending || !focusError.current) return
    const field = fields.find(item => errors[item.name])
    if (field) form.current?.querySelector<HTMLInputElement>(`[name="${field.name}"]`)?.focus()
    else alert.current?.focus()
    focusError.current = false
  }, [pending, errors, error])

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current) return
    const element = event.currentTarget
    const data = new FormData(element)
    // Passwords remain unnormalized and outside React state and persistent storage.
    const values: PasswordChangeInput = { current_password: String(data.get('current_password') ?? ''), password: String(data.get('password') ?? ''), password_confirmation: String(data.get('password_confirmation') ?? '') }
    const validation = validatePasswordChange(values)
    setErrors(validation); setError(null)
    if (Object.keys(validation).length) { focusError.current = true; return }
    inProgress.current = true; setPending(true)
    const request = new AbortController(); controller.current = request
    try {
      await changeOwnPassword(values, request.signal)
      element.reset()
      // The confirmed response already triggered the central authentication-loss flow.
    } catch (cause) {
      if (!mounted.current || generation.current !== getAuthenticationGeneration()) return
      setError(getSettingsErrorMessage(cause))
      if (cause instanceof ApiError && cause.status === 422) {
        const next: PasswordChangeErrors = {}
        for (const field of fields) {
          const message = cause.validationErrors[field.name]?.join(' ')
          if (message) next[field.name] = message
        }
        setErrors(next)
      }
      focusError.current = true
    } finally {
      inProgress.current = false
      if (mounted.current && generation.current === getAuthenticationGeneration()) setPending(false)
    }
  }

  return <section aria-labelledby="settings-security-title" className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
    <h2 id="settings-security-title" className="text-sm font-semibold text-[#263c57]">Segurança</h2>
    <p id="settings-password-notice" className="mt-2 text-xs leading-6 text-[#607189]">Ao alterar a senha, todas as suas sessões serão encerradas. Entre novamente com a nova senha.</p>
    <form ref={form} id="settings-password-form" noValidate aria-labelledby="settings-security-title" aria-describedby="settings-password-notice settings-password-help" aria-busy={pending} onSubmit={event => void submit(event)} className="mt-5 max-w-3xl space-y-5">
      {error && <p ref={alert} tabIndex={-1} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
      <p id="settings-password-help" className="text-xs leading-6 text-[#607189]">{userPasswordHelp}</p>
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        {fields.map(field => <div key={field.name} className={`min-w-0 ${field.name === 'current_password' ? 'sm:col-span-2' : ''}`}>
          <label htmlFor={`settings-${field.name}`} className="mb-2 block text-xs font-medium text-[#3d526d]">{field.label} <span aria-hidden="true">*</span></label>
          <input id={`settings-${field.name}`} name={field.name} type="password" autoComplete={field.autoComplete} required disabled={pending} aria-invalid={Boolean(errors[field.name])} aria-describedby={`settings-password-help${errors[field.name] ? ` settings-${field.name}-error` : ''}`} className={fieldClass} onChange={() => setErrors(current => ({ ...current, [field.name]: undefined }))} />
          {errors[field.name] && <p id={`settings-${field.name}-error`} role="alert" className="mt-2 text-xs leading-5 text-red-700">{errors[field.name]}</p>}
        </div>)}
      </div>
      <div className="flex flex-wrap justify-end"><button type="submit" disabled={pending} className={primaryButtonClass}>{pending ? 'Alterando senha...' : 'Alterar senha'}</button></div>
    </form>
  </section>
}
