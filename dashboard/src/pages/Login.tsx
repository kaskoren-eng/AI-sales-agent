import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioLines } from 'lucide-react'
import { login, forgotPassword, resetPassword, acceptInvite } from '../lib/auth'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { ThemeToggle } from '../components/ThemeToggle'

/**
 * The tenant sign-in screen — sibling to the operator console's AdminLogin, deliberately built
 * from the same vocabulary so the two read as one product rather than two apps.
 *
 * Design note (brief v5 §3.1, "the mono rule"): mono does the STRUCTURAL work — field labels and
 * the status strip — over flat cool surfaces with one restrained accent. No gradients, no glass,
 * no glow; depth is a border plus a soft shadow, exactly as §1.3 specifies. Everything is
 * logical-property based, so the whole screen mirrors correctly under Hebrew RTL.
 */

type Mode = 'login' | 'forgot' | 'sent' | 'reset' | 'invite'

const shell: React.CSSProperties = {
  minBlockSize: '100vh',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--surface-page)',
  color: 'var(--text-primary)',
  padding: '24px',
}

const card: React.CSSProperties = {
  inlineSize: '100%',
  maxInlineSize: '412px',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: '32px',
}

/**
 * Mono, uppercase, tracked — the instrument-panel label treatment (brief v5 §3.1).
 *
 * The uppercase and tracking come from the `.mono-label` CLASS in index.css, deliberately not
 * from inline styles: Hebrew has no uppercase and tracking only pulls a Hebrew word apart, so
 * `[lang="he"] .mono-label` neutralises both — and it can only do that if they are not inlined
 * here, since an inline style outranks any class.
 */
const monoLabel: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  color: 'var(--text-secondary)',
  marginBlockEnd: '7px',
}

const field: React.CSSProperties = {
  inlineSize: '100%',
  paddingBlock: '10px',
  paddingInline: '12px',
  borderRadius: '10px',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-sunken)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)',
  fontSize: '14px',
  outline: 'none',
}

const primaryButton = (disabled: boolean): React.CSSProperties => ({
  inlineSize: '100%',
  marginBlockStart: '20px',
  padding: '11px',
  borderRadius: '10px',
  border: 0,
  background: 'var(--accent)',
  color: 'var(--text-on-accent)',
  fontFamily: 'var(--font-body)',
  fontSize: '14px',
  fontWeight: 600,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.55 : 1,
  transition: 'opacity var(--duration-fast) var(--ease-standard)',
})

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'var(--accent-fg)',
  fontFamily: 'var(--font-body)',
  fontSize: '13px',
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBlockStart: '16px' }}>
      <label className="mono-label" style={monoLabel}>
        {label}
      </label>
      {children}
    </div>
  )
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useTranslation()

  // A reset or invite link lands here with its token in the query string.
  const params = new URLSearchParams(window.location.search)
  const urlToken = params.get('token')
  const initialMode: Mode = urlToken
    ? window.location.pathname.includes('accept-invite')
      ? 'invite'
      : 'reset'
    : 'login'

  const [mode, setMode] = useState<Mode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.genericError'))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return

    if (mode === 'login') {
      void run(async () => {
        await login(email.trim(), password)
        onAuthed()
      })
    } else if (mode === 'forgot') {
      void run(async () => {
        await forgotPassword(email.trim())
        setMode('sent')
      })
    } else if (mode === 'reset') {
      void run(async () => {
        await resetPassword(urlToken!, password)
        // Straight to sign-in with the address they just proved they control.
        window.location.replace('/')
      })
    } else if (mode === 'invite') {
      void run(async () => {
        await acceptInvite({ token: urlToken!, password, name: name.trim() || undefined })
        window.location.replace('/')
      })
    }
  }

  const titles: Record<Mode, string> = {
    login: t('auth.signIn'),
    forgot: t('auth.forgotTitle'),
    sent: t('auth.checkEmail'),
    reset: t('auth.resetTitle'),
    invite: t('auth.inviteTitle'),
  }

  const blurbs: Record<Mode, string> = {
    login: t('auth.signInBlurb'),
    forgot: t('auth.forgotBlurb'),
    sent: t('auth.checkEmailBlurb'),
    reset: t('auth.resetBlurb'),
    invite: t('auth.inviteBlurb'),
  }

  const canSubmit =
    mode === 'login'
      ? email.trim() !== '' && password !== ''
      : mode === 'forgot'
        ? email.trim() !== ''
        : password.length >= 12

  return (
    <div style={shell}>
      <div style={{ inlineSize: '100%', maxInlineSize: '412px' }}>
        <form onSubmit={submit} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBlockEnd: '6px' }}>
            <AudioLines size={22} strokeWidth={1.8} style={{ color: 'var(--accent-fg)' }} aria-hidden />
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '20px', margin: 0 }}>
              ClickScales
            </h1>
          </div>

          {/* In login mode the heading would be the third "Sign in" on one card — after the blurb
              and the button. The brand plus one line of orientation is enough; the button says
              what happens. Other modes DO need a heading, because arriving from an emailed link
              you need telling what this screen is for. */}
          {mode !== 'login' && (
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '16px',
                fontWeight: 700,
                marginBlock: '16px 6px',
              }}
            >
              {titles[mode]}
            </h2>
          )}

          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              marginBlock: mode === 'login' ? '2px 0' : '0',
              lineHeight: 1.55,
            }}
          >
            {blurbs[mode]}
          </p>

          {mode === 'sent' ? (
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBlockStart: '10px' }}>
              {t('auth.checkEmailBody')}
            </p>
          ) : (
            <>
              {(mode === 'login' || mode === 'forgot') && (
                <Field label={t('auth.email')}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    autoFocus
                    dir="ltr"
                    style={field}
                  />
                </Field>
              )}

              {mode === 'invite' && (
                <Field label={t('auth.name')}>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    dir="auto"
                    style={field}
                  />
                </Field>
              )}

              {mode !== 'forgot' && (
                <Field label={mode === 'login' ? t('auth.password') : t('auth.newPassword')}>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    autoFocus={mode !== 'login'}
                    dir="ltr"
                    style={field}
                  />
                  {mode !== 'login' && (
                    <p
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--text-tertiary)',
                        marginBlock: '7px 0',
                      }}
                    >
                      {t('auth.passwordHint')}
                    </p>
                  )}
                </Field>
              )}

              {error && (
                <p
                  role="alert"
                  style={{
                    fontSize: '12.5px',
                    color: 'var(--status-danger)',
                    marginBlockStart: '12px',
                    lineHeight: 1.5,
                  }}
                >
                  {error}
                </p>
              )}

              <button type="submit" disabled={busy || !canSubmit} style={primaryButton(busy || !canSubmit)}>
                {busy
                  ? t('auth.working')
                  : mode === 'login'
                    ? t('auth.signIn')
                    : mode === 'forgot'
                      ? t('auth.sendLink')
                      : t('auth.setPassword')}
              </button>
            </>
          )}

          {mode === 'login' && (
            <div style={{ marginBlockStart: '16px', textAlign: 'center' }}>
              <button type="button" style={linkButton} onClick={() => { setMode('forgot'); setError('') }}>
                {t('auth.forgotLink')}
              </button>
            </div>
          )}

          {(mode === 'forgot' || mode === 'sent') && (
            <div style={{ marginBlockStart: '16px', textAlign: 'center' }}>
              <button type="button" style={linkButton} onClick={() => { setMode('login'); setError('') }}>
                {t('auth.backToSignIn')}
              </button>
            </div>
          )}
        </form>

        {/* Language and theme are reachable BEFORE signing in: a Hebrew speaker who cannot read
            the English form has no other way to change it, and the theme should not flash on the
            first authenticated paint. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginBlockStart: '18px',
          }}
        >
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}
