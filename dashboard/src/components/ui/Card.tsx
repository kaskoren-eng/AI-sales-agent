import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

const paddingMap = {
  none: '0',
  sm: '12px',
  md: '20px',
  lg: '28px',
}

export function Card({ children, padding = 'md', style, className = '', ...props }: CardProps) {
  return (
    <div
      className={className}
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3), 0 1px 8px rgba(0,0,0,0.2)',
        padding: paddingMap[padding],
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  )
}
