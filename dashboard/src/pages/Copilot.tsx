import { useTranslation } from 'react-i18next'
import { Plus, SlidersHorizontal, Mic, ArrowUp, Info, UserPlus, Phone, Clock } from 'lucide-react'

/** Copilot — the Grok-style landing. Never-empty composer with real-state suggestions.
 *  Conversation + confirm-before-apply flow lands in a follow-up step. */
export function Copilot() {
  const { t } = useTranslation()

  const suggestions = [
    { key: 's1', icon: <UserPlus size={15} strokeWidth={1.7} /> },
    { key: 's2', icon: <Phone size={15} strokeWidth={1.7} /> },
    { key: 's3', icon: <SlidersHorizontal size={15} strokeWidth={1.7} /> },
    { key: 's4', icon: <Clock size={15} strokeWidth={1.7} /> },
  ]

  return (
    <div style={{ minBlockSize: 'calc(100vh - 60px - 56px)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'stretch', maxInlineSize: '720px', marginInline: 'auto', gap: '20px', paddingBlock: '24px' }}>
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
        <div style={{ inlineSize: '52px', blockSize: '52px', borderRadius: '50%', background: 'var(--accent)', color: 'var(--text-on-accent)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '22px' }}>
          ק
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '30px', letterSpacing: '-0.02em', color: 'var(--text-primary)' }} className="uppercase-track">
          {t('copilot.title')}
        </h1>
        <p style={{ fontSize: '13.5px', color: 'var(--text-tertiary)', maxInlineSize: '440px' }}>{t('copilot.subtitle')}</p>
      </div>

      {/* composer */}
      <div style={{ border: '1px solid var(--border-strong)', borderRadius: '26px', background: 'var(--surface-card)', boxShadow: 'var(--shadow-card)', padding: '8px' }}>
        <input
          type="text"
          dir="auto"
          placeholder={t('copilot.placeholder')}
          aria-label={t('copilot.placeholder')}
          style={{ inlineSize: '100%', border: 0, outline: 'none', background: 'transparent', fontFamily: 'var(--font-body)', fontSize: '16px', color: 'var(--text-primary)', padding: '12px 12px 8px' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px' }}>
          <button aria-label="Attach" style={ctrlRound}>
            <Plus size={18} strokeWidth={1.8} />
          </button>
          <button style={{ ...ctrlPill }}>
            <SlidersHorizontal size={15} strokeWidth={1.7} /> {t('copilot.skills')}
          </button>
          <span style={{ marginInlineStart: 'auto' }} />
          <button aria-label="Voice" style={ctrlRound}>
            <Mic size={18} strokeWidth={1.7} />
          </button>
          <button aria-label="Send" style={{ inlineSize: '40px', blockSize: '40px', display: 'grid', placeItems: 'center', border: 0, background: 'var(--accent)', color: 'var(--text-on-accent)', borderRadius: '50%', cursor: 'pointer', flexShrink: 0 }}>
            <ArrowUp size={18} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      {/* suggestions */}
      <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {suggestions.map((s) => (
          <button key={s.key} dir="auto" style={ctrlSuggest}>
            <span style={{ color: 'var(--accent-fg)', display: 'inline-flex' }}>{s.icon}</span>
            {t(`copilot.${s.key}`)}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
        <Info size={13} strokeWidth={1.7} />
        <span>{t('copilot.note')}</span>
      </div>
    </div>
  )
}

const ctrlRound: React.CSSProperties = {
  inlineSize: '36px',
  blockSize: '36px',
  display: 'grid',
  placeItems: 'center',
  border: '1px solid var(--border-default)',
  borderRadius: '50%',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
}
const ctrlPill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '7px 12px',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-full)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-body)',
  fontSize: '12.5px',
  fontWeight: 500,
  cursor: 'pointer',
}
const ctrlSuggest: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  fontFamily: 'var(--font-body)',
  fontSize: '13px',
  fontWeight: 500,
  padding: '9px 14px',
  borderRadius: 'var(--r-full)',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-card)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
}
