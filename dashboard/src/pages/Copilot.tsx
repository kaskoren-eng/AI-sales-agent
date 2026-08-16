import { useTranslation } from 'react-i18next'
import { Sparkles, Lock } from 'lucide-react'

/**
 * Copilot — deliberately a COMING SOON page.
 *
 * What it was: a Grok-style landing with a live-looking composer, an attach button, a Skills
 * button, a mic button, a send button and four clickable suggestion chips. None of them did
 * anything — `/chat` has no backend endpoint at all. A customer typing a question and pressing send
 * got silence, which reads as a broken product rather than an unfinished one.
 *
 * Building it for real means an agentic assistant with read AND write access to the tenant's leads,
 * calls and agent settings. That is a product, not a wiring job, and it is not needed for early
 * production — so the honest thing is to say so.
 *
 * The composer is kept as a non-interactive PREVIEW: it shows what the page will be without
 * pretending to be it. `aria-hidden` and `inert` so nothing here is reachable by keyboard or
 * screen reader — a disabled control a user can still tab into is the same lie in a quieter voice.
 */
export function Copilot() {
  const { t } = useTranslation()

  const examples = ['s1', 's2', 's3', 's4'] as const

  return (
    <div
      style={{
        minBlockSize: 'calc(100vh - 60px - 56px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        maxInlineSize: '640px',
        marginInline: 'auto',
        gap: '22px',
        paddingBlock: '24px',
      }}
    >
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
        <div
          style={{
            inlineSize: '52px',
            blockSize: '52px',
            borderRadius: '50%',
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-tertiary)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Sparkles size={24} strokeWidth={1.8} />
        </div>

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 12px',
            borderRadius: 'var(--r-full)',
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-default)',
            fontSize: '11.5px',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}
        >
          <Lock size={12} strokeWidth={2} />
          {t('copilot.soon')}
        </span>

        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: '28px',
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
            margin: 0,
          }}
        >
          {t('copilot.soonTitle')}
        </h1>
        <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', maxInlineSize: '460px', margin: 0, lineHeight: 1.6 }}>
          {t('copilot.soonNote')}
        </p>
      </div>

      {/* A preview of the composer, inert. Shows the shape of the thing without offering it. */}
      <div
        aria-hidden="true"
        // @ts-expect-error -- `inert` is valid HTML; React's types lag behind it in this version.
        inert=""
        style={{
          border: '1px dashed var(--border-strong)',
          borderRadius: '26px',
          background: 'var(--surface-sunken)',
          padding: '18px 20px',
          color: 'var(--text-tertiary)',
          fontSize: '15px',
          opacity: 0.7,
          userSelect: 'none',
        }}
        dir="auto"
      >
        {t('copilot.placeholder')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{ fontSize: '11.5px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)', textAlign: 'center' }}>
          {t('copilot.examplesLabel')}
        </span>
        <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {examples.map((key) => (
            <span
              key={key}
              dir="auto"
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: '13px',
                padding: '8px 14px',
                borderRadius: 'var(--r-full)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                color: 'var(--text-tertiary)',
              }}
            >
              {t(`copilot.${key}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
