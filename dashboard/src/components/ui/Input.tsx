import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  invalid?: boolean
  startIcon?: ReactNode
}

const HEIGHT: Record<'sm' | 'md', string> = { sm: '32px', md: '40px' }
const FONT: Record<'sm' | 'md', string> = { sm: '12px', md: '14px' }

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid = false, startIcon, style, ...props },
  ref,
) {
  const hasIcon = startIcon != null
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      style={{
        width: '100%',
        height: HEIGHT[size],
        // Icon sits in the inline-start gutter — padding is logical so it flips under RTL.
        paddingInlineStart: hasIcon ? '36px' : '12px',
        paddingInlineEnd: '12px',
        backgroundColor: 'var(--bg-inset)',
        border: `1px solid ${invalid ? 'var(--error)' : 'var(--border-default)'}`,
        borderRadius: '8px',
        color: 'var(--text-primary)',
        fontSize: FONT[size],
        fontFamily: "'Assistant', sans-serif",
        outline: 'none',
        transition: `border-color var(--duration-fast) var(--ease-standard)`,
        ...style,
      }}
      {...props}
    />
  )

  if (!hasIcon) return input

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          insetInlineStart: '11px',
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          color: 'var(--text-muted)',
          pointerEvents: 'none',
        }}
      >
        {startIcon}
      </span>
      {input}
    </div>
  )
})
