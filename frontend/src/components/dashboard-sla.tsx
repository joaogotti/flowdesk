import { useEffect, useState } from 'react'
import { getDashboardSla, getDashboardSlaErrorMessage } from '../services/dashboard'
import type { DashboardSla } from '../types/dashboard'
import { buttonClass } from './control-styles'
import Icon from './icon'

interface SlaResult {
  attempt: number
  data: DashboardSla | null
  error: string | null
}

const indicators = [
  { key: 'on_track', label: 'Dentro do prazo', color: 'bg-emerald-600', valueColor: 'text-emerald-800 bg-emerald-50' },
  { key: 'at_risk', label: 'Em risco', color: 'bg-amber-500', valueColor: 'text-amber-900 bg-amber-50' },
  { key: 'overdue', label: 'Vencidos', color: 'bg-red-600', valueColor: 'text-red-800 bg-red-50' },
] as const

export default function DashboardSlaIndicators() {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<SlaResult | null>(null)
  const loading = result?.attempt !== attempt
  const data = !loading ? result?.data : null
  const error = !loading ? result?.error : null

  useEffect(() => {
    const controller = new AbortController()
    // Evita consultas duplicadas na montagem do Strict Mode.
    const timer = window.setTimeout(() => {
      getDashboardSla(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ attempt, data, error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({ attempt, data: null, error: getDashboardSlaErrorMessage(cause) })
        })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [attempt])

  return (
    <section aria-labelledby="dashboard-sla-title" aria-busy={loading} className="py-6">
      <div className="mb-3 flex items-center gap-2 text-[#4674b7]">
        <Icon name="clock" className="size-4" />
        <h3 id="dashboard-sla-title" className="text-xs font-semibold text-[#3d526d]">Prazos de atendimento</h3>
      </div>
      {loading && <p role="status" className="text-xs leading-6 text-[#607189]">Carregando prazos de atendimento...</p>}
      {error && (
        <div role="alert" className="text-xs leading-6 text-red-800">
          <p>{error}</p>
          <button type="button" className={`${buttonClass} mt-3`} onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button>
        </div>
      )}
      {data && (
        <dl className="space-y-3 text-xs">
          {indicators.map(({ key, label, color, valueColor }) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2">
              <dt className="flex items-center gap-2 text-[#3d526d]">
                <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${color}`} />{label}
              </dt>
              <dd className={`rounded-md px-2 py-1 font-semibold tabular-nums ${valueColor}`}>{data[key].toLocaleString('pt-BR')}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
