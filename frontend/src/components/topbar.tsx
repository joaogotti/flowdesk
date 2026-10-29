import type { AuthenticatedUser } from '../types/auth'
import { pageLabels } from '../types/navigation'
import type { WorkspacePage } from '../types/navigation'
import { getUserInitials, roleLabels } from '../utils/user'
import Icon from './icon'

interface TopbarProps {
  page: WorkspacePage
  user: AuthenticatedUser
  isLoggingOut: boolean
  onLogout: () => Promise<void>
}

export default function Topbar({ page, user, isLoggingOut, onLogout }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex min-h-20 items-center justify-between gap-3 border-b border-[#e2e8f0] bg-white px-5 sm:px-8 xl:px-10">
      <div className="min-w-0">
        <p className="hidden text-[11px] text-[#607189] sm:block">Central de atendimento</p>
        <p className="text-sm font-semibold text-[#263c57] sm:mt-1">{pageLabels[page]}</p>
      </div>
      <div className="flex min-w-0 items-center gap-3 sm:gap-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="hidden size-9 shrink-0 items-center justify-center rounded-[10px] border border-[#dce6f3] bg-[#edf3fc] text-xs font-semibold text-[#2864db] min-[400px]:flex" aria-hidden="true">{getUserInitials(user.name)}</span>
          <div className="min-w-0">
            <p className="max-w-27 truncate text-xs font-semibold text-[#263c57] sm:max-w-56 sm:text-[13px]" title={user.name}>{user.name}</p>
            <p className="mt-1 text-[10px] text-[#607189] sm:text-[11px]">{roleLabels[user.role]}</p>
          </div>
        </div>
        <span className="h-8 w-px shrink-0 bg-[#e2e8f0]" aria-hidden="true" />
        <button type="button" onClick={() => void onLogout()} disabled={isLoggingOut} aria-label={isLoggingOut ? 'Saindo da conta' : 'Sair da conta'} className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-2 text-xs font-medium text-[#586c85] transition-colors hover:bg-[#f1f5f9] hover:text-[#172b45] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2864db] disabled:cursor-wait disabled:opacity-60 sm:px-3">
          <Icon name="logout" className="size-4" />
          <span>{isLoggingOut ? 'Saindo...' : 'Sair'}</span>
        </button>
      </div>
    </header>
  )
}
