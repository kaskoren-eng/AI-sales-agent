import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type Language } from '../i18n/index.js'

// Each language is shown in its own script — a picker labels options by what they are,
// not by the current UI language. So these glyphs are intentionally not translated.
const GLYPH: Record<Language, string> = { en: 'EN', he: 'עב' }

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const current: Language = i18n.language.startsWith('he') ? 'he' : 'en'

  return (
    <div
      role="group"
      aria-label={t('language.label')}
      style={{
        display: 'inline-flex',
        padding: '2px',
        borderRadius: '8px',
        backgroundColor: 'var(--bg-inset)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {SUPPORTED_LANGUAGES.map((lng) => {
        const active = lng === current
        return (
          <button
            key={lng}
            type="button"
            onClick={() => i18n.changeLanguage(lng)}
            aria-pressed={active}
            aria-label={lng === 'he' ? t('language.switchToHebrew') : t('language.switchToEnglish')}
            style={{
              minWidth: '34px',
              paddingInline: '10px',
              paddingBlock: '4px',
              borderRadius: '6px',
              border: 'none',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: "'Assistant', sans-serif",
              cursor: active ? 'default' : 'pointer',
              backgroundColor: active ? 'rgba(15, 163, 172, 0.12)' : 'transparent',
              color: active ? 'var(--accent-cyan)' : 'var(--text-muted)',
              transition: `background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)`,
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'
            }}
          >
            {GLYPH[lng]}
          </button>
        )
      })}
    </div>
  )
}
