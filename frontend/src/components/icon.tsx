import type { ReactNode } from 'react'

const paths = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  ticket: <><path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Z" /><path d="M14 5v2m0 4v2m0 4v2" /></>,
  categories: <><rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="4" width="7" height="6" rx="1.5" /><rect x="3" y="14" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /></>,
  reports: <><path d="M4 3v17h17M9 15v-4m5 4V7m5 8V5" /></>,
  settings: <><path d="m10 3-.6 2.3-2 .9L5 5.5 3 9l1.7 1.7v2.6L3 15l2 3.5 2.4-.7 2 .9L10 21h4l.6-2.3 2-.9 2.4.7 2-3.5-1.7-1.7v-2.6L21 9l-2-3.5-2.4.7-2-.9L14 3h-4Z" /><circle cx="12" cy="12" r="3" /></>,
  logout: <><path d="M9 4H4v16h5m5-12 4 4-4 4m-5-4h12" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  alert: <><path d="m10.3 4-8 14a1.5 1.5 0 0 0 1.3 2h16.8a1.5 1.5 0 0 0 1.3-2l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3h.01" /></>,
  inbox: <><path d="m3 13 3-8h12l3 8v6H3v-6Z" /><path d="M3 13h5l2 3h4l2-3h5M9 9h6" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof paths

interface IconProps {
  name: IconName
  className?: string
}

export default function Icon({ name, className = 'size-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
