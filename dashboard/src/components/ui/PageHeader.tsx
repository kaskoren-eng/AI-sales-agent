import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
}

/**
 * In-page header. Applies the display treatment (Montserrat, uppercase, wide tracking)
 * only in Latin — Hebrew gets Heebo with normal case and tracking (brief §1.1), decided
 * here so no page has to special-case it.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  const { i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1
          style={{
            fontFamily: isHebrew ? "'Heebo', sans-serif" : "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '20px',
            letterSpacing: isHebrew ? 'normal' : '0.04em',
            textTransform: isHebrew ? 'none' : 'uppercase',
            color: 'var(--text-primary)',
            margin: 0,
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>{subtitle}</p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>{actions}</div>}
    </div>
  )
}
