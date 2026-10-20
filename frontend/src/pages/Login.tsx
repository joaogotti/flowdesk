import { useState } from 'react'
import type { SubmitEvent } from 'react'
import type { AuthenticatedUser, LoginCredentials, UserRole } from '../types/auth'

interface LoginProps {
  user: AuthenticatedUser | null
  error: string | null
  isCheckingSession: boolean
  isSubmitting: boolean
  onLogin: (credentials: LoginCredentials) => Promise<boolean>
}

const roleLabels: Record<UserRole, string> = {
  requester: 'Solicitante',
  technician: 'Técnico',
  admin: 'Administrador',
}

function Login({ user, error, isCheckingSession, isSubmitting, onLogin }: LoginProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return

    if (!email.trim() || !password) {
      setValidationError('Preencha o e-mail e a senha.')
      return
    }

    if (!event.currentTarget.checkValidity()) {
      setValidationError('Informe um e-mail válido.')
      return
    }

    setValidationError(null)
    if (await onLogin({ email: email.trim(), password })) {
      setPassword('')
      setShowPassword(false)
    }
  }

  return (
    <main className="grid min-h-svh grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:grid-rows-1">
      <section
        aria-labelledby="platform-title"
        className="flex flex-col bg-[#10243c] px-6 py-7 text-white sm:px-10 lg:min-h-svh lg:px-12 lg:py-10 xl:px-18 xl:py-12"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#2864db] text-white" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="size-6">
              <path d="M5 6h14M5 12h10M5 18h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <path d="m16 15 3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="text-[25px] font-semibold tracking-[-0.9px]">flowdesk<span className="text-[#77a8ff]">.</span></span>
          <span className="ml-auto hidden rounded-md border border-white/15 px-2.5 py-1 text-[10px] font-medium tracking-[0.14em] text-[#b5c5d9] xl:block">HELP DESK</span>
        </div>

        <div className="mx-auto hidden w-full max-w-110 flex-1 flex-col justify-center py-16 lg:flex">
          <div className="mb-6 flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.18em] text-[#91b8fb]">
            <span className="h-px w-6 bg-[#79a8f7]" aria-hidden="true" />
            CENTRAL DE ATENDIMENTO
          </div>
          <h2 id="platform-title" className="max-w-105 text-[clamp(2.25rem,3.4vw,3.5rem)] leading-[1.13] font-semibold tracking-[-0.045em]">
            Gestão de chamados,<br />
            <span className="text-[#91b8fb]">do início à solução.</span>
          </h2>
          <p className="mt-6 max-w-87 text-[15px] leading-7 text-[#b5c5d9]">
            Registre solicitações, acompanhe o atendimento e organize as demandas de suporte em um só lugar.
          </p>

          <div className="mt-12 rounded-2xl border border-[#31465f] bg-[#172e49] p-6" aria-hidden="true">
            <div className="mb-6 flex items-center justify-between border-b border-[#31465f] pb-4">
              <span className="text-xs font-medium text-[#d4dfed]">Fluxo de atendimento</span>
              <svg viewBox="0 0 24 24" fill="none" className="size-4 text-[#91a7c2]">
                <path d="M4 7h16M4 12h10M4 17h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <div className="relative space-y-6 before:absolute before:top-5 before:bottom-5 before:left-[17px] before:w-px before:bg-[#3b5270]">
              {[
                { number: '01', title: 'Abertura', description: 'Cada solicitação tem seu lugar.' },
                { number: '02', title: 'Atendimento', description: 'Contexto e acompanhamento da demanda.' },
                { number: '03', title: 'Resolução', description: 'Histórico organizado, do início ao fim.' },
              ].map((step) => (
                <div key={step.number} className="relative flex items-center gap-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-[#445e80] bg-[#1d3857] font-mono text-[11px] text-[#a8c8ff]">{step.number}</span>
                  <div>
                    <p className="text-[13px] font-medium text-[#edf3fc]">{step.title}</p>
                    <p className="mt-1 text-xs leading-5 text-[#a6b9d0]">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="hidden text-xs text-[#a6b9d0] lg:block">Flowdesk <span className="mx-2 text-[#506580]" aria-hidden="true">/</span> Atendimento e suporte técnico</p>
      </section>

      <section aria-labelledby="login-title" className="flex flex-col px-6 pb-6 sm:px-10 lg:min-h-svh lg:px-14">
        <div className="mx-auto flex w-full max-w-100 flex-1 flex-col justify-center py-12 sm:py-16 lg:py-20">
          <span aria-hidden="true" className="mb-7 flex size-12 items-center justify-center rounded-xl border border-[#dae4f2] bg-[#edf3fc] text-[#2864db]">
            <svg viewBox="0 0 24 24" fill="none" className="size-6">
              <path d="M8 10V7a4 4 0 0 1 8 0v3M6 10h12v11H6z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 14v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <p className="mb-3 text-[10px] font-semibold tracking-[0.17em] text-[#586c85]">ACESSO À PLATAFORMA</p>
          <h1 id="login-title" className="text-[30px] leading-tight font-semibold tracking-[-0.035em] sm:text-[32px]">Entrar no Flowdesk</h1>
          <p className="mt-3 text-sm leading-6 text-[#586c85]">Informe suas credenciais para acessar a central de atendimento.</p>

          {isCheckingSession ? (
            <div role="status" className="mt-9 text-sm leading-6 text-[#586c85]">Verificando sessão...</div>
          ) : user ? (
            <div role="status" className="mt-9 text-sm leading-6 text-[#263c57]">
              <p className="font-semibold">Autenticação confirmada</p>
              <p className="mt-3">{user.name} <span aria-hidden="true">·</span> {roleLabels[user.role]}</p>
              <p className="mt-3 text-[#586c85]">Estado temporário de autenticação. As demais telas ainda não estão disponíveis.</p>
            </div>
          ) : (
          <form className="mt-9" onSubmit={handleSubmit} noValidate aria-describedby="login-message" aria-busy={isSubmitting}>
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-[#263c57]">E-mail</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="seu.email@empresa.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={isSubmitting}
                className="h-12 w-full rounded-lg border border-[#c7d2df] bg-white px-3.5 text-sm text-[#172b45] shadow-xs transition-colors outline-none placeholder:text-[#738297] hover:border-[#9caec4] focus:border-[#2864db] focus:ring-3 focus:ring-[#2864db]/15"
              />
            </div>

            <div className="mt-5">
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-[#263c57]">Senha</label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Digite sua senha"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  disabled={isSubmitting}
                  className="h-12 w-full rounded-lg border border-[#c7d2df] bg-white pr-13 pl-3.5 text-sm text-[#172b45] shadow-xs transition-colors outline-none placeholder:text-[#738297] hover:border-[#9caec4] focus:border-[#2864db] focus:ring-3 focus:ring-[#2864db]/15"
                />
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  aria-controls="password"
                  title={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  className="absolute inset-y-1 right-1 flex w-10 items-center justify-center rounded-md text-[#64758c] transition-colors hover:bg-[#eef3f9] hover:text-[#172b45] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2864db]"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
                    {showPassword ? (
                      <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.5 5.3A11 11 0 0 1 12 5c6 0 9 7 9 7a17 17 0 0 1-3.1 4.3M6.1 6.1A18 18 0 0 0 3 12s3 7 9 7a11 11 0 0 0 5.5-1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <>
                        <path d="M3 12s3-7 9-7 9 7 9 7-3 7-9 7-9-7-9-7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.6" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </div>

            <div id="login-message" aria-live="polite" aria-atomic="true" className="min-h-8 pt-2 text-sm text-red-700">{validationError ?? error}</div>

            <button type="submit" disabled={isSubmitting} className="flex h-12 w-full items-center justify-center gap-2.5 rounded-lg bg-[#2864db] px-4 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-[#2055bf] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#2864db] active:bg-[#1d49a2] disabled:cursor-wait disabled:opacity-70">
              {isSubmitting ? 'Entrando...' : 'Entrar'}
              <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
                <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
          )}

          <div className="mt-8 border-t border-[#e0e6ee] pt-6">
            <p className="text-center text-xs leading-5 text-[#64758c]">Acesso exclusivo para usuários cadastrados.</p>
          </div>
        </div>

        <footer className="py-3 text-center text-[11px] text-[#64758c] lg:pb-9">Flowdesk <span className="mx-1.5" aria-hidden="true">·</span> Central de atendimento</footer>
      </section>
    </main>
  )
}

export default Login
