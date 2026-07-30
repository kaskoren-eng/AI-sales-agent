import { useTranslation } from 'react-i18next'
import { Hammer } from 'lucide-react'

/** Interim page for routes whose production build lands in a later Phase-3 step. The nav item is
 *  live so the IA can be navigated; the page states plainly that it is being built to its approved
 *  v5 preview. Replace with the real page as each is migrated. */
export function Placeholder({ titleKey, previewFile }: { titleKey: string; previewFile: string }) {
  const { t } = useTranslation()
  return (
    <div
      style={{
        maxInlineSize: '520px',
        marginInline: 'auto',
        marginBlockStart: '12vh',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '14px',
      }}
    >
      <div
        style={{
          inlineSize: '52px',
          blockSize: '52px',
          borderRadius: '14px',
          background: 'var(--accent-tint)',
          color: 'var(--accent-fg)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Hammer size={22} strokeWidth={1.7} />
      </div>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: '24px',
          letterSpacing: '-0.01em',
          color: 'var(--text-primary)',
        }}
      >
        {t(titleKey)}
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {t('placeholder.body')}
      </p>
      <code
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          color: 'var(--text-tertiary)',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-sm)',
          padding: '6px 10px',
        }}
      >
        dashboard/design-previews/{previewFile}
      </code>
    </div>
  )
}
