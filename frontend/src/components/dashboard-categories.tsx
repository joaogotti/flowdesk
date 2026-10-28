import { useEffect, useState } from 'react'
import { getDashboardCategories, getDashboardCategoriesErrorMessage } from '../services/dashboard'
import type { DashboardCategory } from '../types/dashboard'
import { buttonClass } from './control-styles'
import Icon from './icon'

interface CategoriesResult {
  attempt: number
  data: DashboardCategory[] | null
  error: string | null
}

export default function DashboardCategories() {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<CategoriesResult | null>(null)
  const loading = result?.attempt !== attempt
  const categories = !loading ? result?.data : null
  const error = !loading ? result?.error : null
  const total = categories?.reduce((sum, category) => sum + category.count, 0) ?? 0

  useEffect(() => {
    const controller = new AbortController()
    // Evita consultas duplicadas na montagem do Strict Mode.
    const timer = window.setTimeout(() => {
      getDashboardCategories(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ attempt, data, error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({ attempt, data: null, error: getDashboardCategoriesErrorMessage(cause) })
        })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [attempt])

  return (
    <section aria-labelledby="dashboard-categories-title" aria-busy={loading} className="border-t border-[#e9edf3] py-6">
      <div className="mb-3 flex items-center gap-2 text-[#4674b7]">
        <Icon name="categories" className="size-4" />
        <h3 id="dashboard-categories-title" className="text-xs font-semibold text-[#3d526d]">Organização da fila</h3>
      </div>
      {loading && <p role="status" className="text-xs leading-6 text-[#607189]">Carregando categorias...</p>}
      {error && (
        <div role="alert" className="text-xs leading-6 text-red-800">
          <p>{error}</p>
          <button type="button" className={`${buttonClass} mt-3`} onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button>
        </div>
      )}
      {categories?.length === 0 && <p role="status" className="text-xs leading-6 text-[#607189]">Nenhuma categoria cadastrada.</p>}
      {categories && categories.length > 0 && (
        <ul aria-label="Chamados por categoria" className="space-y-4">
          {categories.map((category) => (
            <li key={category.id}>
              <div className="mb-2 flex items-start justify-between gap-3 text-xs leading-5">
                <span className="min-w-0 wrap-anywhere text-[#3d526d]">{category.name}</span>
                <span className="shrink-0 font-semibold text-[#3d526d] tabular-nums">
                  {category.count.toLocaleString('pt-BR')}<span className="sr-only"> {category.count === 1 ? 'chamado' : 'chamados'}</span>
                </span>
              </div>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-[#edf2f8]">
                <span className="block h-full rounded-full bg-[#4674b7]" style={{ width: `${total > 0 ? (category.count / total) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
