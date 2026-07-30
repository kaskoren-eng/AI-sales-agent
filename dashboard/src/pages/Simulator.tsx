import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Mic, PhoneOff, Send } from 'lucide-react'

type SimState = 'idle' | 'connecting' | 'listening' | 'speaking'

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

interface Turn {
  role: 'agent' | 'user' | 'sys'
  text: string
}

export function Simulator() {
  const { t } = useTranslation()
  const [state, setState] = useState<SimState>('idle')
  const active = state !== 'idle'
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')

  const start = () => {
    setState('speaking')
    setTurns([{ role: 'sys', text: t('simulator.started') }, { role: 'agent', text: 'היי, כאן קרן מקליקסקיילז. יש לך דקה?' }])
  }
  const end = () => {
    setState('idle')
    setTurns([])
  }
  const send = () => {
    if (!draft.trim()) return
    setTurns((tt) => [...tt, { role: 'user', text: draft.trim() }])
    setDraft('')
  }

  const stateLabel = t(`simulator.${state}`)

  return (
    <div style={{ maxInlineSize: '980px', marginInline: 'auto', display: 'grid', gap: '16px', gridTemplateColumns: '1fr', alignItems: 'stretch' }} className="ov-bottom">
      {/* Stage */}
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px', padding: '40px 24px', minBlockSize: '420px' }}>
        <div className={active ? 'sim-orb-active' : undefined} style={{ position: 'relative', inlineSize: '180px', blockSize: '180px', display: 'grid', placeItems: 'center' }}>
          {[180, 140, 100].map((d, i) => (
            <span
              key={d}
              style={{
                position: 'absolute',
                inlineSize: `${d}px`,
                blockSize: `${d}px`,
                borderRadius: '50%',
                border: `1px solid ${active ? 'var(--accent-fg)' : 'var(--border-strong)'}`,
                opacity: active ? 0.35 + i * 0.15 : 0.4,
              }}
            />
          ))}
          <span style={{ inlineSize: '64px', blockSize: '64px', borderRadius: '50%', background: active ? 'var(--accent)' : 'var(--surface-sunken)', border: '1px solid var(--border-strong)' }} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '17px', color: 'var(--text-primary)' }}>{stateLabel}</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', marginBlockStart: '4px', maxInlineSize: '320px' }}>{t('simulator.note')}</div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {!active ? (
            <button onClick={start} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 20px', borderRadius: 'var(--r-full)', border: 0, background: 'var(--accent)', color: 'var(--text-on-accent)', fontFamily: 'var(--font-body)', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
              <Play size={16} strokeWidth={2} /> {t('simulator.start')}
            </button>
          ) : (
            <>
              <button aria-label={t('simulator.mute')} style={{ inlineSize: '44px', blockSize: '44px', borderRadius: '50%', display: 'grid', placeItems: 'center', border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <Mic size={18} strokeWidth={1.7} />
              </button>
              <button onClick={end} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 20px', borderRadius: 'var(--r-full)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)', background: 'color-mix(in srgb, var(--status-danger) 12%, transparent)', color: 'var(--status-danger)', fontFamily: 'var(--font-body)', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
                <PhoneOff size={16} strokeWidth={1.9} /> {t('simulator.end')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Transcript */}
      <div style={{ ...CARD, display: 'flex', flexDirection: 'column', minBlockSize: '420px' }}>
        <div style={{ padding: '14px 18px', borderBlockEnd: '1px solid var(--border-default)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px' }}>
          {t('simulator.transcript')}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {turns.length === 0 ? (
            <div style={{ margin: 'auto', fontSize: '13px', color: 'var(--text-tertiary)' }}>{t('simulator.idle')}</div>
          ) : (
            turns.map((turn, i) =>
              turn.role === 'sys' ? (
                <div key={i} style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>{turn.text}</div>
              ) : (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: turn.role === 'agent' ? 'flex-start' : 'flex-end' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{turn.role === 'agent' ? t('simulator.agent') : t('simulator.you')}</span>
                  <span dir="auto" style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--text-primary)', background: turn.role === 'agent' ? 'var(--surface-sunken)' : 'var(--accent-tint)', border: '1px solid var(--border-default)', borderRadius: '12px', padding: '9px 13px', maxInlineSize: '85%' }}>
                    {turn.text}
                  </span>
                </div>
              ),
            )
          )}
        </div>
        <div style={{ padding: '12px 14px', borderBlockStart: '1px solid var(--border-default)', display: 'flex', gap: '8px' }}>
          <input
            value={draft}
            dir="auto"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={t('simulator.type')}
            disabled={!active}
            style={{ flex: 1, border: '1px solid var(--border-strong)', borderRadius: '10px', background: 'var(--surface-card)', padding: '9px 12px', fontFamily: 'var(--font-body)', fontSize: '14px', color: 'var(--text-primary)', outline: 'none', opacity: active ? 1 : 0.6 }}
          />
          <button onClick={send} aria-label={t('simulator.type')} disabled={!active} style={{ inlineSize: '40px', blockSize: '40px', borderRadius: '10px', display: 'grid', placeItems: 'center', border: 0, background: 'var(--accent)', color: 'var(--text-on-accent)', cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.6, flexShrink: 0 }}>
            <Send size={16} strokeWidth={1.8} className="flip-rtl" />
          </button>
        </div>
      </div>
    </div>
  )
}
