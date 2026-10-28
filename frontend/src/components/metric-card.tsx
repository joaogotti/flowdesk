import Icon from './icon'
import type { IconName } from './icon'

interface MetricCardProps {
  label: string
  description: string
  icon: IconName
  value?: number
  loading?: boolean
  attention?: boolean
}

export default function MetricCard({ label, description, icon, value, loading = false, attention = false }: MetricCardProps) {
  return (
    <article className="rounded-xl border border-[#e0e6ee] bg-white p-5 shadow-[0_1px_2px_0_rgb(16_36_60/0.025)] xl:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium text-[#52657d]">{label}</h2>
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${attention ? 'bg-[#fff6e8] text-[#a86716]' : 'bg-[#f0f5fc] text-[#4674b7]'}`}>
          <Icon name={icon} className="size-4" />
        </span>
      </div>
      <p className={`mt-5 text-[30px] leading-none font-medium text-[#718198] wrap-anywhere ${loading ? 'motion-safe:animate-pulse' : ''}`} aria-label={value === undefined ? (loading ? 'Carregando indicador' : 'Indicador indisponível') : undefined}>{value === undefined ? '—' : value.toLocaleString('pt-BR')}</p>
      <p className="mt-4 text-[11px] leading-5 text-[#607189]">{description}</p>
    </article>
  )
}
