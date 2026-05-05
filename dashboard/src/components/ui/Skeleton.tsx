import type { HTMLAttributes } from 'react'

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  height?: string | number
  width?: string | number
  borderRadius?: string
}

export function Skeleton({
  height = '16px',
  width = '100%',
  borderRadius = '6px',
  style,
  ...props
}: SkeletonProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      style={{
        height: typeof height === 'number' ? `${height}px` : height,
        width: typeof width === 'number' ? `${width}px` : width,
        borderRadius,
        background: 'linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-surface) 50%, var(--bg-elevated) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite linear',
        flexShrink: 0,
        ...style,
      }}
      {...props}
    />
  )
}

/** A row of skeleton cells for table loading states */
export function SkeletonRow({ cols = 5 }: { cols?: number }) {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td
          key={i}
          style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Skeleton height="14px" width={i === 0 ? '60%' : i % 2 === 0 ? '80%' : '50%'} />
        </td>
      ))}
    </tr>
  )
}

/** Block of skeleton rows for a full table loading state */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </>
  )
}
