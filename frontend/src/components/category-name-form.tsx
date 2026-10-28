import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ApiError } from '../services/api'
import { createAdminCategory, getCategoryNameValidationError, getCreateCategoryErrorMessage, getUpdateCategoryErrorMessage, updateAdminCategory } from '../services/admin-categories'
import type { AdminCategory } from '../types/admin-categories'
import { buttonClass, fieldClass, primaryButtonClass } from './control-styles'

export default function CategoryNameForm({ category, onCancel, onSaved }: { category?: AdminCategory; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const mode = category ? 'edit' : 'create'
  const changed = !category || name.trim() !== category.name.trim()

  useEffect(() => {
    mounted.current = true
    nameRef.current?.focus({ preventScroll: true })
    return () => { mounted.current = false }
  }, [])

  function cancel() {
    if (!inProgress.current) onCancel()
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current || !changed) return
    const normalized = name.trim()
    const validation = getCategoryNameValidationError(name)
    setError(null)
    setNameError(validation)
    if (validation) {
      nameRef.current?.focus({ preventScroll: true })
      return
    }
    inProgress.current = true
    setPending(true)
    try {
      if (category) await updateAdminCategory(category.id, { name: normalized })
      else await createAdminCategory({ name: normalized })
    } catch (cause) {
      inProgress.current = false
      if (mounted.current) {
        setPending(false)
        setError(category ? getUpdateCategoryErrorMessage(cause) : getCreateCategoryErrorMessage(cause))
        if (cause instanceof ApiError && cause.status === 422) setNameError(cause.validationErrors.name?.join(' ') || null)
        window.requestAnimationFrame(() => nameRef.current?.focus({ preventScroll: true }))
      }
      return
    }
    if (mounted.current) onSaved()
  }

  return (
    <section id={`category-${mode}-panel`} aria-labelledby={`category-${mode}-title`} className="mb-6 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id={`category-${mode}-title`} className="text-sm font-semibold text-[#263c57]">{category ? 'Editar categoria' : 'Nova categoria'}</h2>
      {category && <p id="category-edit-description" className="mt-2 text-xs leading-6 wrap-anywhere text-[#607189]">Editando: {category.name}.</p>}
      <form noValidate aria-labelledby={`category-${mode}-title`} aria-describedby={category ? 'category-edit-description' : undefined} aria-busy={pending} onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-5 max-w-xl space-y-5">
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        <div>
          <label htmlFor={`category-${mode}-name`} className="mb-2 block text-xs font-medium text-[#3d526d]">Nome da categoria <span aria-hidden="true">*</span></label>
          <input ref={nameRef} id={`category-${mode}-name`} name="name" required maxLength={100} disabled={pending} value={name} onChange={(event) => { setName(event.target.value); setNameError(null) }} aria-invalid={Boolean(nameError)} aria-describedby={`category-name-count${nameError ? ' category-name-error' : ''}`} className={fieldClass} />
          <p id="category-name-count" className="mt-2 text-right text-[11px] text-[#607189]">{Array.from(name).length}/100 caracteres</p>
          {nameError && <p id="category-name-error" role="alert" className="mt-2 text-xs leading-5 text-red-700">{nameError}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" disabled={pending} onClick={cancel} className={buttonClass}>Cancelar</button>
          <button type="submit" disabled={pending || !changed} className={primaryButtonClass}>{category ? (pending ? 'Salvando alterações...' : 'Salvar alterações') : (pending ? 'Criando categoria...' : 'Criar categoria')}</button>
        </div>
      </form>
    </section>
  )
}
