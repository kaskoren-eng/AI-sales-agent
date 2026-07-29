import { Sun, Moon, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../hooks/useTheme.js'
import type { ThemePref } from '../lib/theme.js'

const OPTIONS: { value: ThemePref; icon: React.ReactNode; labelKey: string }[] = [
  { value: 'light', icon: <Sun size={15} strokeWidth={1.7} />, labelKey: 'theme.light' },
  { value: 'dark', icon: <Moon size={15} strokeWidth={1.7} />, labelKey: 'theme.dark' },
  { value: 'system', icon: <Monitor size={15} strokeWidth={1.7} />, labelKey: 'theme.system' },
]

/** Three-state appearance control (light / dark / system). Reads and writes the shared theme
 *  store, so it stays in sync with Settings › Profile › Appearance. */
export function ThemeToggle() {
  const { pref, setPref } = useTheme()
  const { t } = useTranslation()

  return (
    <div
      role="group"
      aria-label={t('theme.label')}
      style={{
        display: 'inline-flex',
        padding: '2px',
        borderRadius: '8px',
        backgroundColor: 'var(--surface-sunken)',
        border: '1px solid var(--border-default)',
      }}
    >
      {OPTIONS.map((opt) => {
        const active = pref === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setPref(opt.value)}
            aria-pressed={active}
            aria-label={t(opt.labelKey)}
            title={t(opt.labelKey)}
            style={{
              width: '34px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              border: 'none',
              cursor: active ? 'default' : 'pointer',
              backgroundColor: active ? 'var(--surface-card)' : 'transparent',
              boxShadow: active ? 'var(--shadow-card)' : 'none',
              color: active ? 'var(--accent-fg)' : 'var(--text-tertiary)',
              transition: `color var(--duration-fast) var(--ease-standard)`,
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)'
            }}
          >
            {opt.icon}
          </button>
        )
      })}
    </div>
  )
}
