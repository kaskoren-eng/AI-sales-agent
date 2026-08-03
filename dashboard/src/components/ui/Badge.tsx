import type { ReactNode } from 'react'

type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'default' | 'violet'

interface BadgeProps {
  variant?: BadgeVariant
  children: ReactNode
  className?: string
}

const variantStyles: Record<BadgeVariant, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  info: 'badge-info',
  default: 'badge-default',
  violet: 'badge-violet',
}

export function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`badge ${variantStyles[variant]} ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        paddingInline: '8px',
        paddingBlock: '2px',
        borderRadius: '9999px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-body)',
        ...variantInlineStyles[variant],
      }}
    >
      {children}
    </span>
  )
}

// v4: light tint of the semantic color over cream, text in a darkened shade of the same hue
// so 11px badge text clears AA on the tint (the raw mid-tone accents do not — verified in the
// Phase A contrast pass). Tints stay ~0.12 so the pill reads as a wash, not a solid chip.
const variantInlineStyles: Record<BadgeVariant, React.CSSProperties> = {
  success: {
    backgroundColor: 'rgba(29, 158, 117, 0.12)',
    color: '#0F6B4F',
    border: '1px solid rgba(29, 158, 117, 0.28)',
  },
  warning: {
    backgroundColor: 'rgba(180, 83, 9, 0.12)',
    color: 'var(--status-warning)',
    border: '1px solid rgba(180, 83, 9, 0.28)',
  },
  error: {
    backgroundColor: 'rgba(179, 38, 30, 0.12)',
    color: 'var(--status-danger)',
    border: '1px solid rgba(179, 38, 30, 0.28)',
  },
  info: {
    backgroundColor: 'rgba(24, 95, 165, 0.12)',
    color: 'var(--data-1)',
    border: '1px solid rgba(24, 95, 165, 0.28)',
  },
  default: {
    backgroundColor: 'rgba(38, 37, 36, 0.06)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-default)',
  },
  violet: {
    backgroundColor: 'rgba(91, 91, 214, 0.12)',
    color: 'var(--data-1)',
    border: '1px solid rgba(91, 91, 214, 0.28)',
  },
}

/** Maps lead/call status strings to Badge variants */
export function statusToBadgeVariant(status: string): BadgeVariant {
  switch (status.toLowerCase()) {
    case 'qualified':
    case 'won':
    case 'completed':
    case 'done':
      return 'success'
    case 'contacted':
    case 'in_progress':
    case 'processing':
      return 'warning'
    case 'booked':
    case 'scheduled':
      return 'violet'
    case 'lost':
    case 'failed':
    case 'error':
      return 'error'
    case 'new':
    case 'pending':
      return 'info'
    default:
      return 'default'
  }
}
