import { useId } from 'react'

export default function ReportDistribution({ title, items }: { title: string; items: { label: string; count: number }[] }) {
  const id = useId()
  const total = items.reduce((sum, item) => sum + item.count, 0)
  return <section aria-labelledby={id} className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5">
    <h3 id={id} className="text-sm font-semibold text-[#263c57]">{title}</h3>
    {total === 0 ? <p className="mt-4 text-sm text-[#607189]">Nenhum chamado criado no período.</p> : <ul className="mt-5 space-y-4">
      {items.map((item, index) => <li key={index}>
        <div className="mb-2 flex justify-between gap-3 text-xs leading-5 text-[#3d526d]"><span className="min-w-0 wrap-anywhere">{item.label}</span><span className="shrink-0 font-semibold tabular-nums">{item.count.toLocaleString('pt-BR')}<span className="sr-only"> chamados</span></span></div>
        <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-[#edf2f8]"><span className="block h-full rounded-full bg-[#4674b7]" style={{ width: `${100 * item.count / total}%` }} /></div>
      </li>)}
    </ul>}
  </section>
}
