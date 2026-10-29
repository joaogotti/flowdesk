import type { ReactNode } from 'react'
import type { AuthenticatedUser } from '../types/auth'
import type { WorkspacePage } from '../types/navigation'
import Sidebar from '../components/sidebar'
import Topbar from '../components/topbar'

interface AuthenticatedLayoutProps {
  page: WorkspacePage
  user: AuthenticatedUser
  isLoggingOut: boolean
  logoutError: string | null
  onLogout: () => Promise<void>
  children: ReactNode
}

export default function AuthenticatedLayout({ page, user, isLoggingOut, logoutError, onLogout, children }: AuthenticatedLayoutProps) {
  return (
    <div className="min-h-svh bg-[#f5f7fa]">
      <a href="#conteudo" onClick={(event) => { event.preventDefault(); document.getElementById('conteudo')?.focus() }} className="sr-only z-50 rounded-lg bg-white p-3 text-sm text-[#172b45] focus:fixed focus:top-3 focus:left-3 focus:not-sr-only focus:outline-2 focus:outline-[#2864db]">Ir para o conteúdo</a>
      <Sidebar page={page} isAdmin={user.role === 'admin'} />
      <div className="min-w-0 lg:pl-64">
        <Topbar page={page} user={user} isLoggingOut={isLoggingOut} onLogout={onLogout} />
        <main id="conteudo" tabIndex={-1} className="mx-auto max-w-400 px-5 py-7 outline-none sm:px-8 sm:py-9 xl:px-10">
          {logoutError && <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800">{logoutError}</div>}
          {children}
        </main>
      </div>
    </div>
  )
}
