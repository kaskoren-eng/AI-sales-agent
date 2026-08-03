import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /** 'glass' (default) blurs the cream behind it; 'solid' is opaque — use for rows
   *  inside a scroll container, where blur kills 60fps (brief §1 glass rules). */
  variant?: 'glass' | 'solid'
}

const paddingMap = {
  none: '0',
  sm: '12px',
  md: '20px',
  lg: '28px',
}

export function Card({ children, padding = 'md', variant = 'glass', style, className = '', ...props }: CardProps) {
  const glassClass = variant === 'solid' ? 'glass-solid' : 'glass'
  return (
    <div
      className={`${glassClass} ${className}`.trim()}
      style={{
        // material (bg/border/radius) comes from the .glass class; no shadow on glass
        padding: paddingMap[padding],
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  )
}
