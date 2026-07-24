import { forwardRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  /** Set when the field holds user-generated (possibly Hebrew) content → dir="auto". */
  userContent?: boolean
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid = false, userContent = false, rows = 4, style, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      dir={userContent ? 'auto' : undefined}
      aria-invalid={invalid || undefined}
      style={{
        width: '100%',
        padding: '10px 12px',
        backgroundColor: 'var(--bg-inset)',
        border: `1px solid ${invalid ? 'var(--error)' : 'var(--border-default)'}`,
        borderRadius: '8px',
        color: 'var(--text-primary)',
        fontSize: '14px',
        fontFamily: "'Assistant', sans-serif",
        lineHeight: 1.5,
        outline: 'none',
        resize: 'vertical',
        ...style,
      }}
      {...props}
    />
  )
})
