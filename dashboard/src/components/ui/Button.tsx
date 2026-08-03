import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  children: ReactNode
}

const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  borderRadius: '8px',
  border: 'none',
  cursor: 'pointer',
  transition: `background-color var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)`,
  whiteSpace: 'nowrap',
  letterSpacing: '0.01em',
  position: 'relative',
  userSelect: 'none',
}

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { paddingInline: '12px', paddingBlock: '6px', fontSize: '12px', height: '30px' },
  md: { paddingInline: '16px', paddingBlock: '8px', fontSize: '14px', height: '36px' },
  lg: { paddingInline: '24px', paddingBlock: '10px', fontSize: '15px', height: '44px' },
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--accent-fg)',
    color: 'var(--text-on-accent)',
  },
  secondary: {
    backgroundColor: 'var(--surface-card)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid transparent',
  },
  danger: {
    backgroundColor: 'rgba(179, 38, 30, 0.10)',
    color: 'var(--status-danger)',
    border: '1px solid rgba(179, 38, 30, 0.25)',
  },
}

const Spinner = () => (
  <span
    style={{
      width: '14px',
      height: '14px',
      border: '2px solid currentColor',
      borderTopColor: 'transparent',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }}
    aria-hidden="true"
  />
)

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading

  return (
    <button
      disabled={isDisabled}
      style={{
        ...baseStyle,
        ...sizeStyles[size],
        ...variantStyles[variant],
        opacity: isDisabled ? 0.5 : 1,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
}
