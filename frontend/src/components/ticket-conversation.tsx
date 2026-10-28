import type { TicketComment } from '../types/tickets'
import type { ReactNode } from 'react'
import { getUserInitials } from '../utils/user'
import Icon from './icon'
import TicketDate from './ticket-date'

export default function TicketConversation({ comments, children }: { comments: TicketComment[]; children?: ReactNode }) {
  return (
    <section aria-labelledby="conversation-title" className="overflow-hidden rounded-xl border border-[#dce3ed] bg-white shadow-[0_1px_2px_0_rgb(16_36_60/0.025)]">
      <div className="border-b border-[#e9edf3] px-5 py-5 sm:px-6">
        <h2 id="conversation-title" className="text-base font-semibold text-[#172b45]">Conversa</h2>
        <p className="mt-1 text-xs leading-5 text-[#607189]">Comentários e informações compartilhadas no atendimento.</p>
      </div>
      {comments.length ? (
        <ol className="divide-y divide-[#e9edf3]">
          {comments.map((comment) => (
            <li key={comment.id} className={`p-5 sm:p-6 ${comment.is_internal === true ? 'bg-amber-50/40' : ''}`}>
              <article aria-label={`Comentário de ${comment.author.name}`} className="flex gap-3">
                <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#dce6f3] bg-[#edf3fc] text-xs font-semibold text-[#3d5e8a]">{getUserInitials(comment.author.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold wrap-anywhere text-[#263c57]">{comment.author.name}</h3>
                      {comment.is_internal === true && <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">Interno</span>}
                    </div>
                    <span className="text-[11px] text-[#607189]"><TicketDate value={comment.created_at} /></span>
                  </div>
                  <p className="mt-3 text-sm leading-7 whitespace-pre-wrap wrap-anywhere text-[#3d526d]">{comment.body}</p>
                </div>
              </article>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
          <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl border border-[#e3eaf3] bg-[#f5f8fc] text-[#7892b3]"><Icon name="inbox" className="size-5" /></span>
          <p className="mt-4 text-sm font-medium text-[#3d526d]">Ainda não há comentários</p>
          <p className="mt-2 max-w-80 text-xs leading-6 text-[#607189]">Os comentários disponíveis para sua conta aparecerão nesta conversa.</p>
        </div>
      )}
      {children}
    </section>
  )
}
