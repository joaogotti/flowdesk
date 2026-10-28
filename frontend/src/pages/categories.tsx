import { useEffect, useRef, useState } from 'react'
import { buttonClass, primaryButtonClass } from '../components/control-styles'
import CategoryCreateForm from '../components/category-create-form'
import CategoryNameForm from '../components/category-name-form'
import CategoryStatusConfirmation from '../components/category-status-confirmation'
import { getAdminCategories } from '../services/admin-categories'
import { getCategoriesErrorMessage } from '../services/categories'
import type { AdminCategory } from '../types/admin-categories'
import type { AuthenticatedUser } from '../types/auth'

interface CategoriesResult {
  attempt: number
  data: AdminCategory[] | null
  error: string | null
}

export default function Categories({ user }: { user: AuthenticatedUser }) {
  if (user.role !== 'admin') {
    return (
      <div role="alert" className="rounded-xl border border-[#e0e6ee] bg-white p-6">
        <h1 className="text-xl font-semibold text-[#172b45]">Acesso não permitido</h1>
        <p className="mt-3 text-sm leading-6 text-[#607189]">Somente administradores podem consultar as categorias administrativas.</p>
        <a href="#/visao-geral" className={`${buttonClass} mt-5`}>Voltar à Visão geral</a>
      </div>
    )
  }

  return <CategoriesList />
}

function CategoriesList() {
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminCategory | null>(null)
  const [changingStatus, setChangingStatus] = useState<AdminCategory | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const editButtons = useRef(new Map<number, HTMLButtonElement>())
  const statusButtons = useRef(new Map<number, HTMLButtonElement>())
  const statusFocusAfterRefresh = useRef<number | null>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const focusAfterRefresh = useRef<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<CategoriesResult | null>(null)
  const loading = result?.attempt !== attempt
  const data = !loading ? result?.data : null
  const error = !loading ? result?.error : null

  function closeStatusConfirmation(refresh = false) {
    const id = changingStatus?.id
    setChangingStatus(null)
    if (refresh && id !== undefined) statusFocusAfterRefresh.current = id
    else window.requestAnimationFrame(() => ((id !== undefined ? statusButtons.current.get(id) : null) ?? createButton.current)?.focus())
  }

  useEffect(() => {
    if (loading || statusFocusAfterRefresh.current === null) return
    const target = statusButtons.current.get(statusFocusAfterRefresh.current) ?? retryButton.current ?? createButton.current
    if (data) statusFocusAfterRefresh.current = null
    target?.focus()
  }, [loading, data])

  function closeForm() {
    setCreating(false)
    window.requestAnimationFrame(() => createButton.current?.focus({ preventScroll: true }))
  }

  function closeEditor(refresh = false) {
    const id = editing?.id
    setEditing(null)
    if (refresh && id !== undefined) focusAfterRefresh.current = id
    window.requestAnimationFrame(() => ((id !== undefined ? editButtons.current.get(id) : null) ?? createButton.current)?.focus({ preventScroll: true }))
  }

  useEffect(() => {
    if (loading || focusAfterRefresh.current === null) return
    const target = editButtons.current.get(focusAfterRefresh.current) ?? createButton.current
    focusAfterRefresh.current = null
    target?.focus({ preventScroll: true })
  }, [loading, data])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getAdminCategories(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ attempt, data, error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({ attempt, data: null, error: getCategoriesErrorMessage(cause) })
        })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [attempt])

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2.5 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">ADMINISTRAÇÃO</p>
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.035em] text-[#172b45] sm:text-[32px]">Categorias</h1>
          <p className="mt-2.5 text-[13px] leading-6 text-[#607189]">Gerencie as categorias utilizadas nos chamados.</p>
        </div>
        <button ref={createButton} type="button" disabled={creating || editing !== null || changingStatus !== null} aria-expanded={creating} aria-controls={creating ? 'category-create-panel' : undefined} onClick={() => { setSuccess(null); setCreating(true) }} className={primaryButtonClass}>Nova categoria</button>
      </div>
      {success && <p role="status" className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{success}</p>}
      {changingStatus && <CategoryStatusConfirmation key={changingStatus.id} category={changingStatus} onCancel={() => closeStatusConfirmation()} onSaved={() => { closeStatusConfirmation(true); setSuccess(changingStatus.is_active ? 'Categoria desativada com sucesso.' : 'Categoria ativada com sucesso.'); setAttempt((value) => value + 1) }} />}
      {creating && <CategoryCreateForm onCancel={closeForm} onCreated={() => { closeForm(); setSuccess('Categoria criada com sucesso.'); setAttempt((value) => value + 1) }} />}
      {editing && <CategoryNameForm key={editing.id} category={editing} onCancel={() => closeEditor()} onSaved={() => { closeEditor(true); setSuccess('Categoria alterada com sucesso.'); setAttempt((value) => value + 1) }} />}
      <section aria-labelledby="categories-title" aria-busy={loading} className="min-w-0 overflow-hidden rounded-xl border border-[#e0e6ee] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
        <div className="px-5 py-5 sm:px-6">
          <h2 id="categories-title" className="text-sm font-semibold text-[#263c57]">Lista de categorias</h2>
        </div>
        {loading && <p role="status" className="border-t border-[#e9edf3] px-6 py-16 text-center text-sm text-[#607189]">Carregando categorias...</p>}
        {error && (
          <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800 sm:m-6">
            <p className="leading-6">{error}</p>
            <button ref={retryButton} type="button" className={`${buttonClass} mt-4`} onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button>
          </div>
        )}
        {data && (data.length === 0 ? (
          <p role="status" className="border-t border-[#e9edf3] px-6 py-16 text-center text-sm text-[#607189]">Nenhuma categoria cadastrada.</p>
        ) : (
          <div role="region" aria-label="Tabela de categorias, role horizontalmente para ver todas as colunas" tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2864db]">
            <table className="w-full min-w-140 table-fixed border-collapse text-left text-xs">
              <caption className="sr-only">Categorias ativas e inativas e seus chamados vinculados</caption>
              <thead className="border-y border-[#e9edf3] bg-[#fafbfd] text-[#607189]">
                <tr>
                  <th scope="col" className="w-[40%] py-3.5 pr-4 pl-6 font-medium">Categoria</th>
                  <th scope="col" className="w-[17%] px-4 py-3.5 font-medium">Situação</th>
                  <th scope="col" className="w-[23%] px-4 py-3.5 font-medium">Chamados vinculados</th>
                  <th scope="col" className="w-[20%] py-3.5 pr-6 pl-4 font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf0f5]">
                {data.map((category) => (
                  <tr key={category.id} className="text-[#3d526d] hover:bg-[#fafbfd]">
                    <th scope="row" className="py-5 pr-4 pl-6 text-[13px] leading-6 font-medium wrap-anywhere text-[#263c57]">{category.name}</th>
                    <td className="px-4 py-5"><span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-medium ${category.is_active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{category.is_active ? 'Ativa' : 'Inativa'}</span></td>
                    <td className="px-4 py-5 tabular-nums">{category.tickets_count.toLocaleString('pt-BR')}</td>
                    <td className="py-5 pr-6 pl-4">
                      <div className="flex flex-wrap gap-2">
                      <button ref={(node) => { if (node) editButtons.current.set(category.id, node); else editButtons.current.delete(category.id) }} type="button" disabled={creating || editing !== null || changingStatus !== null} aria-label={`Editar categoria ${category.name}`} aria-expanded={editing?.id === category.id} aria-controls={editing?.id === category.id ? 'category-edit-panel' : undefined} onClick={() => { setSuccess(null); setEditing(category) }} className={buttonClass}>Editar</button>
                      <button ref={(node) => { if (node) statusButtons.current.set(category.id, node); else statusButtons.current.delete(category.id) }} type="button" disabled={creating || editing !== null || changingStatus !== null} aria-label={`${category.is_active ? 'Desativar' : 'Ativar'} categoria ${category.name}`} aria-expanded={changingStatus?.id === category.id} aria-controls={changingStatus?.id === category.id ? 'category-status-panel' : undefined} onClick={() => { setSuccess(null); setChangingStatus(category) }} className={`${buttonClass} ${category.is_active ? 'text-amber-800' : 'text-emerald-800'}`}>{category.is_active ? 'Desativar' : 'Ativar'}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </>
  )
}
