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
        fontFamily: "'Assistant', sans-serif",
        ...variantInlineStyles[variant],
      }}
    >
      {children}
    </span>
  )
}

const variantInlineStyles: Record<BadgeVariant, React.CSSProperties> = {
  success: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    color: 'var(--success)',
    border: '1px solid rgba(16, 185, 129, 0.3)',
  },
  warning: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    color: 'var(--warning)',
    border: '1px solid rgba(245, 158, 11, 0.3)',
  },
  error: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    color: 'var(--error)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
  },
  info: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    color: 'var(--info)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
  },
  default: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-default)',
  },
  violet: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    color: 'var(--accent-violet)',
    border: '1px solid rgba(99, 102, 241, 0.3)',
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
