import { useEffect, useState } from 'react'
import { buttonClass } from '../components/control-styles'
import ProfileSettingsForm from '../components/profile-settings-form'
import PasswordSettingsForm from '../components/password-settings-form'
import { getCurrentUser } from '../services/auth'
import { getAuthenticationGeneration } from '../services/api'
import { getSettingsErrorMessage } from '../services/settings'
import type { AuthenticatedUser } from '../types/auth'

interface Props { user: AuthenticatedUser; onUserUpdated: (user: AuthenticatedUser) => void }

export default function Settings({ user, onUserUpdated }: Props) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ attempt: number; user?: AuthenticatedUser; error?: string } | null>(null)
  const loading = result?.attempt !== attempt

  useEffect(() => {
    let active = true
    const generation = getAuthenticationGeneration()
    const timer = window.setTimeout(() => {
      getCurrentUser().then(current => {
        if (!active || generation !== getAuthenticationGeneration()) return
        onUserUpdated(current)
        setResult({ attempt, user: current })
      }).catch((cause: unknown) => {
        if (active && generation === getAuthenticationGeneration()) setResult({ attempt, error: getSettingsErrorMessage(cause) })
      })
    }, 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [attempt, onUserUpdated])

  return <>
    <div className="mb-8">
      <p className="mb-2.5 text-[10px] font-semibold tracking-[0.15em] text-[#607189]">MINHA CONTA</p>
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.035em] text-[#172b45] sm:text-[32px]">Configurações</h1>
      <p className="mt-2.5 text-[13px] leading-6 text-[#607189]">Gerencie seu perfil e a segurança da sua conta.</p>
    </div>
    {loading ? <p role="status" className="rounded-xl border border-[#e0e6ee] bg-white p-6 text-sm text-[#607189]">Carregando seu perfil...</p> : result?.error ?
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p>{result.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)} className={`${buttonClass} mt-4`}>Tentar novamente</button>
      </div> : result?.user && <div className="space-y-6">
        <ProfileSettingsForm user={result.user} onUserUpdated={onUserUpdated} />
        <PasswordSettingsForm />
        {user.role === 'admin' && <section aria-labelledby="settings-admin-title" className="min-w-0 rounded-xl border border-[#e0e6ee] bg-white p-5 sm:p-6">
          <h2 id="settings-admin-title" className="text-sm font-semibold text-[#263c57]">Administração</h2>
          <p className="mt-2 text-xs leading-6 text-[#607189]">Acesse o gerenciamento administrativo do Flowdesk.</p>
          <div className="mt-5 flex flex-wrap gap-3"><a href="#/usuarios" className={buttonClass}>Gerenciar usuários</a><a href="#/categorias" className={buttonClass}>Gerenciar categorias</a></div>
        </section>}
      </div>}
  </>
}
