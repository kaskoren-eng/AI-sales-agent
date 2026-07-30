import { forwardRef } from 'react'
import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'size'> {
  options: SelectOption[]
  placeholder?: string
  size?: 'sm' | 'md'
  invalid?: boolean
  /** false → content-sized (for inline filters); true (default) → fills its container. */
  fullWidth?: boolean
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, size = 'md', invalid = false, fullWidth = true, style, ...props },
  ref,
) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', width: fullWidth ? '100%' : 'auto' }}>
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        style={{
          width: fullWidth ? '100%' : 'auto',
          height: size === 'sm' ? '32px' : '40px',
          appearance: 'none',
          // Chevron gutter is inline-end — logical padding flips under RTL.
          paddingInlineStart: '12px',
          paddingInlineEnd: '32px',
          backgroundColor: 'var(--surface-sunken)',
          border: `1px solid ${invalid ? 'var(--status-danger)' : 'var(--border-default)'}`,
          borderRadius: '8px',
          color: 'var(--text-primary)',
          fontSize: size === 'sm' ? '12px' : '14px',
          fontFamily: "'Assistant', sans-serif",
          outline: 'none',
          cursor: 'pointer',
          ...style,
        }}
        {...props}
      >
        {placeholder != null && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {/* Chevron as a real element (not a background-image) so it sits on the correct side in RTL. */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          insetInlineEnd: '10px',
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          color: 'var(--text-tertiary)',
          pointerEvents: 'none',
        }}
      >
        <ChevronDown size={14} strokeWidth={1.5} />
      </span>
    </div>
  )
})
