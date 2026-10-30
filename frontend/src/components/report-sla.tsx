import { useId } from 'react'
import { reportSlaLabels } from '../types/reports'
import type { ReportSla } from '../types/reports'

export default function ReportSlaIndicator({ title, data }: { title: string; data: ReportSla }) {
  const id = useId()
  return <section aria-labelledby={id} className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
    <h3 id={id} className="text-sm font-semibold text-[#263c57]">{title}</h3>
    <p className="mt-4 text-2xl font-semibold text-[#263c57]">{data.compliance_rate === null ? 'Não disponível' : `${data.compliance_rate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`}</p>
    <p className="mt-2 text-xs leading-6 text-[#607189]">{data.met.toLocaleString('pt-BR')} no prazo / {data.compliance_denominator.toLocaleString('pt-BR')} obrigações concluídas avaliáveis. Pendências não entram no percentual.</p>
    <dl className="mt-4 divide-y divide-[#edf0f5]">
      {Object.entries(reportSlaLabels).map(([key, label]) => <div key={key} className="flex justify-between gap-3 py-2 text-xs leading-6"><dt className="text-[#607189]">{label}</dt><dd className={`font-semibold tabular-nums ${key === 'pending_overdue' || key === 'late' ? 'text-amber-800' : 'text-[#263c57]'}`}>{data[key as keyof typeof reportSlaLabels].toLocaleString('pt-BR')}</dd></div>)}
    </dl>
    <p className="mt-3 text-xs leading-6 text-[#607189]">Cancelados excluídos: {data.cancelled_excluded.toLocaleString('pt-BR')} — já incluídos em “Não avaliável”.</p>
  </section>
}
