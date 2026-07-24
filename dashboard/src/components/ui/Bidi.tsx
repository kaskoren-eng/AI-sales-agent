import type { CSSProperties, ElementType, ReactNode } from 'react'

interface BidiProps {
  as?: ElementType
  children: ReactNode
  style?: CSSProperties
  className?: string
  title?: string
}

/**
 * Wraps user-generated content — lead names, notes, summaries, transcript text — so the
 * browser infers direction from the text itself (`dir="auto"`), independent of UI language.
 * A Hebrew name stays right-to-left even while the dashboard is in English, and vice versa.
 */
export function Bidi({ as: Tag = 'span', children, style, className, title }: BidiProps) {
  return (
    <Tag dir="auto" style={style} className={className} title={title}>
      {children}
    </Tag>
  )
}
