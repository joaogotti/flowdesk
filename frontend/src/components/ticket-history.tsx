import type { TicketActivity } from '../types/tickets'
import { getTicketActivityEntries } from '../utils/ticket-history'
import TicketDate from './ticket-date'

export default function TicketHistory({ activities }: { activities: TicketActivity[] }) {
  return (
    <section aria-labelledby="history-title" className="rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
      <h2 id="history-title" className="text-sm font-semibold text-[#263c57]">Histórico de atividades</h2>
      {activities.length ? (
        <ol className="mt-5 divide-y divide-[#edf0f5]">
          {activities.map((activity) => (
            <li key={activity.id} className="py-4 first:pt-0 last:pb-0">
              {getTicketActivityEntries(activity).map((entry, index) => (
                <div key={entry.title} className={index ? 'mt-2' : undefined}>
                  <div className="flex items-start justify-between gap-4">
                    <p className="min-w-0 text-xs font-medium wrap-anywhere text-[#3d526d]">{entry.title}</p>
                    {index === 0 && <span className="shrink-0 text-[11px] whitespace-nowrap text-[#607189]"><TicketDate value={activity.created_at} /></span>}
                  </div>
                  {entry.transition !== undefined && <p className="mt-1 text-xs leading-5 wrap-anywhere text-[#607189]">{entry.transition}</p>}
                </div>
              ))}
              {activity.actor && <p className="mt-1.5 text-xs wrap-anywhere text-[#607189]">{activity.actor.name}</p>}
            </li>
          ))}
        </ol>
      ) : <p className="mt-4 text-xs leading-6 text-[#607189]">Nenhuma atividade disponível para sua conta.</p>}
    </section>
  )
}
