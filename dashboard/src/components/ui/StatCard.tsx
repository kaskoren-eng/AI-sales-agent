import type { ReactNode } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Card } from './Card.js'
import { Skeleton } from './Skeleton.js'

interface StatCardProps {
  icon: ReactNode
  label: string
  value: string | number
  delta?: {
    value: number
    label?: string
  }
  loading?: boolean
  accentColor?: string
}

export function StatCard({
  icon,
  label,
  value,
  delta,
  loading = false,
  accentColor = 'var(--accent-violet)',
}: StatCardProps) {
  const isPositive = delta && delta.value > 0
  const isNegative = delta && delta.value < 0

  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            backgroundColor: `color-mix(in srgb, ${accentColor} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accentColor} 30%, transparent)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: accentColor,
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          {icon}
        </div>
        {delta && !loading && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
              fontSize: '12px',
              fontWeight: 600,
              color: isPositive ? 'var(--success)' : isNegative ? 'var(--error)' : 'var(--text-muted)',
            }}
            aria-label={`${isPositive ? 'Up' : isNegative ? 'Down' : 'No change'} ${Math.abs(delta.value)}${delta.label ?? ''}`}
          >
            {isPositive ? (
              <TrendingUp size={13} strokeWidth={2} />
            ) : isNegative ? (
              <TrendingDown size={13} strokeWidth={2} />
            ) : (
              <Minus size={13} strokeWidth={2} />
            )}
            {isPositive ? '+' : ''}{delta.value}{delta.label ?? '%'}
          </span>
        )}
      </div>

      {loading ? (
        <>
          <Skeleton height="32px" width="60%" />
          <Skeleton height="13px" width="50%" />
        </>
      ) : (
        <>
          <span
            style={{
              fontSize: '28px',
              fontWeight: 700,
              color: 'var(--text-primary)',
              fontFamily: "'Montserrat', sans-serif",
              lineHeight: 1.1,
            }}
          >
            {value}
          </span>
          <span
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              fontWeight: 400,
            }}
          >
            {label}
          </span>
        </>
      )}
    </Card>
  )
}
