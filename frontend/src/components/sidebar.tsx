import { useState } from 'react'
import Icon from './icon'
import type { IconName } from './icon'
import { pageLabels } from '../types/navigation'
import type { WorkspacePage } from '../types/navigation'

const availableNavigation: { page: WorkspacePage; href: string; icon: IconName }[] = [
  { page: 'overview', href: '#/visao-geral', icon: 'overview' },
  { page: 'tickets', href: '#/chamados', icon: 'ticket' },
]

const adminNavigation: { page: WorkspacePage; href: string; icon: IconName }[] = [
  { page: 'categories', href: '#/categorias', icon: 'categories' },
  { page: 'users', href: '#/usuarios', icon: 'shield' },
  { page: 'reports', href: '#/relatorios', icon: 'reports' },
]

const upcomingNavigation: { label: string; icon: IconName }[] = [
  { label: 'Relatórios', icon: 'reports' },
  { label: 'Configurações', icon: 'settings' },
]

export default function Sidebar({ page, isAdmin }: { page: WorkspacePage; isAdmin: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const activePage = page === 'new-ticket' || page === 'ticket-details' ? 'tickets' : page

  return (
    <aside className="z-30 flex flex-col bg-[#10243c] text-white lg:fixed lg:inset-y-0 lg:left-0 lg:w-64">
      <div className="flex h-20 shrink-0 items-center justify-between border-b border-white/8 px-6 lg:h-24 lg:px-7">
        <div className="flex items-center gap-3" aria-label="Flowdesk">
          <span className="flex size-9 items-center justify-center rounded-[10px] bg-[#2864db]" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="size-5.5">
              <path d="M5 6h14M5 12h10M5 18h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <path d="m16 15 3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="text-[25px] font-semibold tracking-[-0.9px]">flowdesk<span className="text-[#77a8ff]">.</span></span>
        </div>
        <button type="button" aria-label={menuOpen ? 'Recolher navegação' : 'Expandir navegação'} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(!menuOpen)} className="flex size-10 items-center justify-center rounded-lg text-[#c6d4e6] hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#91b8fb] lg:hidden">
          <Icon name={menuOpen ? 'close' : 'menu'} />
        </button>
      </div>

      <nav id="workspace-navigation" aria-label="Navegação principal" className={`${menuOpen ? 'block' : 'hidden'} px-4 py-7 lg:block`}>
        <p className="mb-4 px-3 text-[10px] font-semibold tracking-[0.16em] text-[#91a7c2]">ESPAÇO DE TRABALHO</p>
        <ul className="space-y-1.5">
          {(isAdmin ? [...availableNavigation, ...adminNavigation] : availableNavigation).map((item) => (
            <li key={item.page}>
              <a href={item.href} aria-current={activePage === item.page ? 'page' : undefined} onClick={() => setMenuOpen(false)} className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#91b8fb] ${activePage === item.page ? 'border-[#3d69a9]/50 bg-[#24456f] text-white' : 'border-transparent text-[#a7b9cf] hover:bg-white/5 hover:text-white'}`}>
                <Icon name={item.icon} className="size-4.5 text-[#a7c9ff]" />
                {pageLabels[item.page]}
                {activePage === item.page && <span className="ml-auto size-1.5 rounded-full bg-[#91b8fb]" aria-hidden="true" />}
              </a>
            </li>
          ))}
          {upcomingNavigation.filter(item => !isAdmin || item.icon !== 'reports').map((item) => (
            <li key={item.label}>
              <button type="button" disabled className="flex min-h-11 w-full cursor-not-allowed items-center gap-3 rounded-lg px-3 text-left text-[13px] text-[#a7b9cf]">
                <Icon name={item.icon} className="size-4.5 shrink-0 text-[#91a7c2]" />
                {item.label}
                <span className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[9px] whitespace-nowrap text-[#a7b9cf]">Em breve</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-auto hidden border-t border-white/8 px-7 py-6 lg:block">
        <p className="text-xs font-medium text-[#d1ddec]">Central de atendimento</p>
        <p className="mt-1.5 text-[11px] text-[#91a7c2]">Flowdesk · Help desk</p>
      </div>
    </aside>
  )
}
