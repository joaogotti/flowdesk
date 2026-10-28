import { useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import { getCategoryStatusErrorMessage, updateAdminCategoryStatus } from '../services/admin-categories'
import type { AdminCategory } from '../types/admin-categories'
import { buttonClass } from './control-styles'

export default function CategoryStatusConfirmation({ category, onCancel, onSaved }: { category: AdminCategory; onCancel: () => void; onSaved: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const inProgress = useRef(false)
  const mounted = useRef(true)
  const action = category.is_active ? 'Desativar' : 'Ativar'

  useEffect(() => {
    mounted.current = true
    cancelButton.current?.focus()
    return () => { mounted.current = false }
  }, [])

  function cancel() {
    if (!inProgress.current) onCancel()
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inProgress.current) return
    inProgress.current = true
    setPending(true)
    setError(null)
    try {
      await updateAdminCategoryStatus(category.id, { is_active: !category.is_active })
    } catch (cause) {
      inProgress.current = false
      if (mounted.current) {
        setPending(false)
        setError(getCategoryStatusErrorMessage(cause))
        window.requestAnimationFrame(() => cancelButton.current?.focus({ preventScroll: true }))
      }
      return
    }
    if (mounted.current) onSaved()
  }

  return (
    <section id="category-status-panel" aria-labelledby="category-status-title" className="mb-6 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id="category-status-title" className="text-sm font-semibold text-[#263c57]">{action} categoria</h2>
      <p id="category-status-description" className="mt-3 text-sm leading-6 wrap-anywhere text-[#3d526d]">
        Deseja {action.toLowerCase()} a categoria <strong>{category.name}</strong>?
        {category.is_active ? ' Ela deixará de estar disponível para novos chamados. Os chamados existentes continuarão vinculados a ela. A categoria poderá ser reativada posteriormente.' : ' Ela ficará disponível para novos chamados.'}
      </p>
      <form aria-labelledby="category-status-title" aria-describedby="category-status-description" aria-busy={pending} onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="mt-5 space-y-4">
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        {pending && <p role="status" className="text-sm text-[#607189]">Alterando situação...</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button ref={cancelButton} type="button" disabled={pending} onClick={cancel} className={buttonClass}>Cancelar</button>
          <button type="submit" disabled={pending} className={`${buttonClass} ${category.is_active ? 'border-amber-200 text-amber-800 hover:bg-amber-50' : 'border-emerald-200 text-emerald-800 hover:bg-emerald-50'}`}>{pending ? 'Aguarde...' : `${action} categoria`}</button>
        </div>
      </form>
    </section>
  )
}
