import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Globe, ChevronDown } from 'lucide-react'

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

type Tab = 'tone' | 'accuracy' | 'trust'
interface Beh {
  key: string
  sampleKey: string
  locked?: boolean
}
const TABS: Record<Tab, Beh[]> = {
  tone: [
    { key: 'filler', sampleKey: 'filler' },
    { key: 'empathy', sampleKey: 'empathy' },
    { key: 'short', sampleKey: 'short' },
  ],
  accuracy: [
    { key: 'confirm', sampleKey: 'confirm' },
    { key: 'numbers', sampleKey: 'numbers' },
  ],
  trust: [
    { key: 'disclose', sampleKey: 'disclose', locked: true },
    { key: 'record', sampleKey: 'record' },
  ],
}

function Switch({ on, locked, onToggle, label }: { on: boolean; locked?: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={locked}
      onClick={() => !locked && onToggle()}
      style={{
        inlineSize: '42px',
        blockSize: '24px',
        borderRadius: 'var(--r-full)',
        background: on ? 'var(--accent)' : 'var(--surface-sunken)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
        position: 'relative',
        padding: 0,
        cursor: locked ? 'not-allowed' : 'pointer',
        opacity: locked ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          insetBlockStart: '2px',
          insetInlineStart: on ? 'calc(100% - 20px)' : '2px',
          inlineSize: '18px',
          blockSize: '18px',
          borderRadius: '50%',
          background: 'var(--text-on-accent)',
          boxShadow: '0 1px 2px rgba(12,18,38,.25)',
          transition: 'inset-inline-start var(--duration-fast) var(--ease-standard)',
        }}
      />
    </button>
  )
}

export function AgentPersonality() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('tone')
  const [tone, setTone] = useState<'pro' | 'warm'>('warm')
  const [gender, setGender] = useState<'female' | 'male'>('female')
  const [name, setName] = useState('קרן')
  const [advanced, setAdvanced] = useState(false)
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    filler: true, empathy: true, short: false, confirm: true, numbers: true, disclose: true, record: true,
  })

  const secTitle: React.CSSProperties = { fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '16px', margin: '28px 0 12px' }
  const seg = (active: boolean): React.CSSProperties => ({
    fontFamily: 'var(--font-body)', fontSize: '13px', fontWeight: 500, padding: '7px 16px', border: 0, borderRadius: '7px', cursor: 'pointer',
    background: active ? 'var(--surface-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)', boxShadow: active ? 'var(--shadow-card)' : 'none',
  })
  const segWrap: React.CSSProperties = { display: 'inline-flex', padding: '3px', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: '10px' }

  return (
    <div style={{ maxInlineSize: '860px', marginInline: 'auto', paddingBlockEnd: '80px' }}>
      <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', marginBlockEnd: '20px' }}>{t('agent.sub')}</p>

      {/* metrics strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1px', background: 'var(--border-default)', border: '1px solid var(--border-default)', borderRadius: 'var(--r)', overflow: 'hidden' }}>
        {[
          { k: t('agent.metrics.cost'), v: '$0.08', n: t('agent.metrics.costNote') },
          { k: t('agent.metrics.latency'), v: '1.2s', n: t('agent.metrics.latencyNote') },
          { k: t('agent.metrics.voice'), v: 'Sonic · עברית', n: t('agent.metrics.voiceNote') },
        ].map((m, i) => (
          <div key={i} style={{ background: 'var(--surface-card)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{m.k}</span>
            <span style={{ fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: i === 2 ? '16px' : '20px' }} dir="auto">{m.v}</span>
            <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{m.n}</span>
          </div>
        ))}
      </div>

      {/* identity */}
      <h2 style={secTitle}>{t('agent.identity')}</h2>
      <div style={{ ...CARD, padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('agent.name')}</span>
          <input
            value={name}
            dir="auto"
            onChange={(e) => setName(e.target.value)}
            style={{ fontFamily: 'var(--font-body)', fontSize: '15px', color: 'var(--text-primary)', padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: '10px', background: 'var(--surface-card)', maxInlineSize: '320px' }}
          />
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('agent.nameHint')}</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('agent.gender')}</span>
          <div style={{ ...segWrap, inlineSize: 'max-content' }}>
            <button style={seg(gender === 'female')} onClick={() => setGender('female')}>{t('agent.female')}</button>
            <button style={seg(gender === 'male')} onClick={() => setGender('male')}>{t('agent.male')}</button>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('agent.genderHint')}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('agent.voice')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', border: '1px solid var(--border-default)', borderRadius: '12px', background: 'var(--surface-sunken)', maxInlineSize: '420px' }}>
            <button aria-label={t('agent.voice')} style={{ inlineSize: '38px', blockSize: '38px', borderRadius: '50%', display: 'grid', placeItems: 'center', border: 0, background: 'var(--accent)', color: 'var(--text-on-accent)', cursor: 'pointer', flexShrink: 0 }}>
              <Play size={15} strokeWidth={2} style={{ marginInlineStart: '2px' }} />
            </button>
            <div style={{ flex: 1, minInlineSize: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '14px' }} dir="auto">קרן — Sonic Hebrew</div>
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('agent.voiceDesc')}</div>
            </div>
            <button style={{ background: 'transparent', border: '1px solid var(--border-default)', borderRadius: '9px', padding: '7px 12px', fontFamily: 'var(--font-body)', fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>{t('agent.voiceChange')}</button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--text-tertiary)', padding: '10px 12px', borderRadius: '10px', background: 'var(--surface-sunken)' }}>
          <Globe size={15} strokeWidth={1.7} style={{ flexShrink: 0 }} />
          <span>{t('agent.langNote')}</span>
        </div>
      </div>

      {/* handbook */}
      <h2 style={secTitle}>{t('agent.handbook')}</h2>
      <div style={CARD}>
        <div style={{ display: 'flex', gap: '4px', borderBlockEnd: '1px solid var(--border-default)', padding: '0 6px' }} role="tablist">
          {(['tone', 'accuracy', 'trust'] as Tab[]).map((tk) => (
            <button
              key={tk}
              role="tab"
              aria-selected={tab === tk}
              onClick={() => setTab(tk)}
              style={{ fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: tab === tk ? 600 : 500, padding: '14px 12px', border: 0, background: 'transparent', color: tab === tk ? 'var(--text-primary)' : 'var(--text-secondary)', borderBlockEnd: `2px solid ${tab === tk ? 'var(--accent)' : 'transparent'}`, marginBlockEnd: '-1px', cursor: 'pointer' }}
            >
              {t(`agent.tabs.${tk}`)}
            </button>
          ))}
        </div>
        <div style={{ padding: '6px 20px 8px' }}>
          {tab === 'tone' && (
            <BehRow name={t('agent.b.tone')} desc={t('agent.b.toneD')} sample={t('agent.sample.warm')} says={t('agent.says')}
              control={<div style={{ ...segWrap }}><button style={seg(tone === 'pro')} onClick={() => setTone('pro')}>{t('agent.b.pro')}</button><button style={seg(tone === 'warm')} onClick={() => setTone('warm')}>{t('agent.b.warm')}</button></div>} />
          )}
          {TABS[tab].map((b) => (
            <BehRow
              key={b.key}
              name={t(`agent.b.${b.key}`)}
              desc={t(`agent.b.${b.key}D`)}
              sample={t(`agent.sample.${b.sampleKey}`)}
              says={t('agent.says')}
              control={<Switch on={!!toggles[b.key]} locked={b.locked} label={t(`agent.b.${b.key}`)} onToggle={() => setToggles((s) => ({ ...s, [b.key]: !s[b.key] }))} />}
            />
          ))}
        </div>
      </div>

      {/* advanced */}
      <div style={{ marginBlockStart: '14px' }}>
        <button
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', inlineSize: '100%', background: 'transparent', border: '1px solid var(--border-default)', borderRadius: '12px', padding: '12px 14px', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: 600, color: 'var(--text-primary)' }}
        >
          <span>{t('agent.advanced')}</span>
          <ChevronDown size={16} strokeWidth={1.8} style={{ marginInlineStart: 'auto', transform: advanced ? 'rotate(180deg)' : 'none', transition: 'transform var(--duration-fast) var(--ease-standard)', color: 'var(--text-tertiary)' }} />
        </button>
        {advanced && (
          <div style={{ marginBlockStart: '10px', border: '1px solid var(--border-default)', borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ padding: '9px 14px', background: 'var(--surface-sunken)', borderBlockEnd: '1px solid var(--border-default)', fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{t('agent.advancedRo')}</div>
            <pre style={{ margin: 0, padding: '14px', fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }} dir="auto">
{`## תפקיד
את ${name}, נציגת מכירות של קליקסקיילז.
מדברת עברית, טון ${tone === 'warm' ? 'חם' : 'מקצועי'}, עם מילות חיבור טבעיות.

## מהלך השיחה
1. פתיחה קצרה + הודעת הקלטה
2. שאלת גילוי אחת על העסק
3. הבנת הכאב המרכזי
4. קביעת פגישת דמו לליד מתאים`}
            </pre>
          </div>
        )}
      </div>

      {/* save bar */}
      <div style={{ position: 'sticky', insetBlockEnd: 0, marginBlockStart: '24px', background: 'var(--surface-card)', borderBlockStart: '1px solid var(--border-default)', padding: '12px 4px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '12.5px', color: 'var(--text-tertiary)' }}>{t('agent.saveNote')}</span>
        <div style={{ marginInlineStart: 'auto', display: 'flex', gap: '10px' }}>
          <button style={{ fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: 600, padding: '9px 18px', borderRadius: '10px', border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-primary)', cursor: 'pointer' }}>{t('agent.discard')}</button>
          <button style={{ fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: 600, padding: '9px 18px', borderRadius: '10px', border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--text-on-accent)', cursor: 'pointer' }}>{t('agent.save')}</button>
        </div>
      </div>
    </div>
  )
}

function BehRow({ name, desc, sample, says, control }: { name: string; desc: string; sample: string; says: string; control: React.ReactNode }) {
  return (
    <div style={{ padding: '18px 0', borderBlockEnd: '1px solid var(--border-default)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
        <div style={{ flex: 1, minInlineSize: 0 }}>
          <div style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--text-primary)' }}>{name}</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBlockStart: '2px' }}>{desc}</div>
        </div>
        <div style={{ flexShrink: 0 }}>{control}</div>
      </div>
      <div style={{ marginBlockStart: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
        <span style={{ inlineSize: '26px', blockSize: '26px', borderRadius: '50%', background: 'var(--accent)', color: 'var(--text-on-accent)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '11px', flexShrink: 0 }}>ק</span>
        <div style={{ flex: 1, minInlineSize: 0 }}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBlockEnd: '4px' }}>{says}</div>
          <span style={{ display: 'inline-block', padding: '9px 13px', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: '12px', borderStartStartRadius: '3px', fontSize: '14px', lineHeight: 1.55, color: 'var(--text-primary)' }} dir="auto">
            {sample}
          </span>
        </div>
      </div>
    </div>
  )
}
