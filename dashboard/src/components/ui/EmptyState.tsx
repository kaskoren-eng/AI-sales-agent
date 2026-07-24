import type { CSSProperties, ReactNode } from 'react'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
  style?: CSSProperties
}

/**
 * The shared empty-state block — icon, title, optional description and action.
 * Consolidates the near-identical copies previously inlined in Leads, Bookings, etc.
 * Caller controls the icon size; pass `style` to tune padding for a given container.
 */
export function EmptyState({ icon, title, description, action, style }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px', ...style }}>
      <div
        aria-hidden="true"
        style={{
          color: 'var(--text-disabled)',
          marginBottom: '12px',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {icon}
      </div>
      <p
        style={{
          fontSize: '15px',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          marginBottom: description ? '6px' : 0,
        }}
      >
        {title}
      </p>
      {description && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '360px', marginInline: 'auto' }}>
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: '20px' }}>{action}</div>}
    </div>
  )
}
