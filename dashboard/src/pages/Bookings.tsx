import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Clock, Timer, Bell, CalendarDays, Globe, Video, ChevronDown } from 'lucide-react'
import { fetchBookings } from '../lib/api.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { formatDate } from '../lib/format.js'

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

const AVAIL_ROWS = [
  { key: 'hours', icon: <Clock size={17} strokeWidth={1.7} /> },
  { key: 'length', icon: <Timer size={17} strokeWidth={1.7} /> },
  { key: 'buffer', icon: <CalendarDays size={17} strokeWidth={1.7} /> },
  { key: 'notice', icon: <Bell size={17} strokeWidth={1.7} /> },
  { key: 'calendar', icon: <CalendarDays size={17} strokeWidth={1.7} /> },
  { key: 'tz', icon: <Globe size={17} strokeWidth={1.7} /> },
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu']
const SLOTS = ['09:00', '09:40', '10:20', '11:00', '11:40', '12:20']

export function Bookings() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const { data, isLoading, isError } = useQuery({ queryKey: ['bookings'], queryFn: fetchBookings, staleTime: 60_000 })
  const bookings = data?.data ?? []

  const secHead: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: '12px', margin: '4px 0 12px' }
  const secTitle: React.CSSProperties = { fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '17px' }
  const secNote: React.CSSProperties = { fontSize: '12.5px', color: 'var(--text-tertiary)' }

  return (
    <div style={{ maxInlineSize: 'var(--container-max)', marginInline: 'auto' }}>
      {/* Upcoming */}
      <div style={secHead}>
        <h2 style={secTitle}>{t('calendar.upcoming')}</h2>
      </div>
      <div style={{ ...CARD, overflow: 'hidden', marginBlockEnd: '30px' }}>
        {isError ? (
          <div role="alert" style={{ padding: '32px', textAlign: 'center', color: 'var(--status-danger)', fontSize: '14px' }}>{t('calendar.error')}</div>
        ) : isLoading ? (
          <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height="18px" />)}
          </div>
        ) : bookings.length === 0 ? (
          <div style={{ padding: '48px 20px', textAlign: 'center' }}>
            <CalendarDays size={28} strokeWidth={1.3} style={{ color: 'var(--text-tertiary)', display: 'block', margin: '0 auto 10px' }} />
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{t('calendar.empty')}</p>
          </div>
        ) : (
          bookings.map((b, i) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '15px 18px', borderBlockEnd: i < bookings.length - 1 ? '1px solid var(--border-default)' : '0' }}>
              <div style={{ inlineSize: '128px', flexShrink: 0, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: '13px', color: 'var(--text-secondary)' }}>
                {formatDate(b.scheduledAt)}
              </div>
              <div style={{ flex: 1, minInlineSize: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '14.5px', color: 'var(--text-primary)' }} dir="auto">{b.leadName ?? '—'}</div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{t('calendar.demo')} · {b.provider}</div>
              </div>
              <a href="#" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 13px', border: '1px solid var(--border-default)', borderRadius: '9px', fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none' }}>
                <Video size={14} strokeWidth={1.8} /> {t('calendar.join')}
              </a>
            </div>
          ))
        )}
      </div>

      {/* Availability config + booking preview */}
      <div style={secHead}>
        <h2 style={secTitle}>{t('calendar.availTitle')}</h2>
        <span style={secNote}>{t('calendar.availSub')}</span>
      </div>
      <div style={{ display: 'grid', gap: '22px', alignItems: 'start' }} className="ov-bottom">
        {/* summary rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {AVAIL_ROWS.map((r) => (
            <div key={r.key} style={{ ...CARD, display: 'flex', alignItems: 'center', gap: '14px', padding: '15px 16px' }}>
              <span style={{ inlineSize: '34px', blockSize: '34px', borderRadius: '9px', background: 'var(--surface-sunken)', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)', flexShrink: 0 }}>{r.icon}</span>
              <div style={{ flex: 1, minInlineSize: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-tertiary)' }}>{t(`calendar.rows.${r.key}`)}</div>
                <div style={{ fontSize: '14.5px', color: 'var(--text-primary)', marginBlockStart: '2px' }} dir="auto">{t(`calendar.rows.${r.key}V`)}</div>
              </div>
              <ChevronDown size={18} strokeWidth={1.8} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            </div>
          ))}
        </div>

        {/* booking preview */}
        <div style={{ position: 'sticky', top: '84px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBlockEnd: '10px' }}>
            <span style={{ fontFamily: isHebrew ? 'var(--font-body)' : 'var(--font-mono)', fontSize: isHebrew ? '12px' : '11px', fontWeight: isHebrew ? 600 : 400, letterSpacing: isHebrew ? 'normal' : '0.12em', textTransform: isHebrew ? 'none' : 'uppercase', color: 'var(--text-tertiary)' }}>
              {t('calendar.preview.eyebrow')}
            </span>
          </div>
          <div style={CARD}>
            <div style={{ padding: '20px', borderBlockEnd: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', gap: '13px' }}>
              <div style={{ inlineSize: '46px', blockSize: '46px', borderRadius: '50%', background: 'var(--accent)', color: 'var(--text-on-accent)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '18px' }}>ק</div>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '18px' }}>{t('calendar.preview.title')}</div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{t('calendar.preview.meta')}</div>
              </div>
            </div>
            <div style={{ padding: '16px 20px 20px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-tertiary)', marginBlockEnd: '9px' }}>{t('calendar.preview.pickDay')}</div>
              <div style={{ display: 'flex', gap: '7px' }}>
                {DAYS.map((d, i) => (
                  <div key={d} style={{ flex: 1, padding: '9px 0', borderRadius: '10px', border: '1px solid var(--border-default)', background: i === 0 ? 'var(--accent)' : 'var(--surface-card)', textAlign: 'center' }}>
                    <div style={{ fontSize: '11px', color: i === 0 ? 'var(--text-on-accent)' : 'var(--text-tertiary)' }}>{d}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 600, color: i === 0 ? 'var(--text-on-accent)' : 'var(--text-primary)', marginBlockStart: '2px' }}>{i + 2}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-tertiary)', margin: '16px 0 9px' }}>{t('calendar.preview.pickTime')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                {SLOTS.map((s, i) => (
                  <div key={s} style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: '13.5px', padding: '10px 0', borderRadius: '9px', border: `1px solid ${i === 2 ? 'var(--accent)' : 'var(--border-default)'}`, background: i === 2 ? 'var(--accent-tint)' : 'var(--surface-card)', color: i === 2 ? 'var(--accent-fg)' : 'var(--text-primary)', textAlign: 'center' }}>{s}</div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBlockStart: '16px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                <Globe size={13} strokeWidth={1.7} /> {t('calendar.preview.tznote')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
