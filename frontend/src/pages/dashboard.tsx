import { useEffect, useState } from 'react'
import MetricCard from '../components/metric-card'
import DashboardRecentTickets from '../components/dashboard-recent-tickets'
import DashboardSlaIndicators from '../components/dashboard-sla'
import DashboardCategories from '../components/dashboard-categories'
import Icon from '../components/icon'
import { buttonClass } from '../components/control-styles'
import { getDashboardErrorMessage, getDashboardStats } from '../services/dashboard'
import type { DashboardStats } from '../types/dashboard'

interface StatsResult {
  attempt: number
  data: DashboardStats | null
  error: string | null
}

export default function Dashboard() {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<StatsResult | null>(null)
  const isLoading = result?.attempt !== attempt
  const stats = !isLoading ? result?.data : null
  const error = !isLoading ? result?.error : null

  useEffect(() => {
    const controller = new AbortController()
    // O temporizador evita consultas duplicadas na montagem do Strict Mode.
    const timer = window.setTimeout(() => {
      getDashboardStats(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ attempt, data, error: null })
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setResult({ attempt, data: null, error: getDashboardErrorMessage(cause) })
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
          <p className="mb-2.5 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">PAINEL DE ATENDIMENTO</p>
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.035em] text-[#172b45] sm:text-[32px]">Visão geral</h1>
          <p className="mt-2.5 max-w-150 text-[13px] leading-6 text-[#607189]">Resumo dos chamados e dos prazos de atendimento da sua operação.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-md border border-[#e0e6ee] bg-white px-2.5 py-1.5 text-[10px] font-medium text-[#607189]">
          <span className="size-1.5 rounded-full bg-[#8da0b7]" aria-hidden="true" />
          {isLoading ? 'Carregando indicadores' : error ? 'Indicadores indisponíveis' : 'Dados atualizados'}
        </span>
      </div>

      <section aria-label="Indicadores de atendimento" aria-busy={isLoading} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:gap-5">
        <MetricCard label="Total de chamados" description="Chamados disponíveis para sua conta" icon="ticket" value={stats?.total} loading={isLoading} />
        <MetricCard label="Abertos" description="Solicitações que aguardam atendimento" icon="inbox" value={stats?.open} loading={isLoading} />
        <MetricCard label="Em andamento" description="Chamados em atendimento" icon="clock" value={stats?.in_progress} loading={isLoading} />
        <MetricCard label="Sem responsável" description="Chamados que aguardam atribuição" icon="alert" value={stats?.unassigned} loading={isLoading} attention />
      </section>
      {error ? (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className={`${buttonClass} mt-3`}>Tentar novamente</button>
        </div>
      ) : (
      <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] leading-5 text-[#607189]">
        <Icon name="clock" className="size-3.5 shrink-0" />
        {isLoading ? 'Carregando indicadores...' : stats?.total === 0 ? 'Nenhum chamado disponível para sua conta.' : 'Indicadores dos chamados disponíveis para sua conta.'}
      </p>
      )}

      <div className="mt-8 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <DashboardRecentTickets />

        <aside aria-labelledby="operations-title" className="overflow-hidden rounded-xl border border-[#e0e6ee] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
          <div className="border-b border-[#e9edf3] px-5 py-5">
            <h2 id="operations-title" className="text-sm font-semibold text-[#263c57]">Informações operacionais</h2>
            <p className="mt-1 text-xs leading-5 text-[#607189]">Referências para o atendimento.</p>
          </div>
          <div className="px-5">
            <DashboardSlaIndicators />
            <DashboardCategories />
          </div>
          <div className="border-t border-[#e9edf3] bg-[#fafbfd] px-5 py-4">
            <p className="text-[10px] font-semibold tracking-[0.08em] text-[#607189]">SOBRE ESTE PAINEL</p>
            <p className="mt-2 text-[11px] leading-5 text-[#607189]">Os espaços estão preparados para os próximos recursos de atendimento.</p>
          </div>
        </aside>
      </div>
    </>
  )
}
