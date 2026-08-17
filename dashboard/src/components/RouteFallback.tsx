import { Skeleton } from './ui/Skeleton.js'

/**
 * What a lazily-loaded route shows while its chunk is downloading.
 *
 * `null` was the obvious choice and the wrong one. A blank frame after a nav click reads as a
 * broken button: the user clicks the sidebar item again, and on the connection where the chunk is
 * slowest — the exact case splitting exists for — they keep clicking. Showing that something is
 * happening is what makes code-splitting safe to do at all.
 *
 * Deliberately generic and deliberately quiet: a page-shaped shimmer, not a spinner and not a
 * detailed mock of the specific page. A fallback that imitates the real layout has to be updated
 * whenever that layout changes, and when it drifts it produces a visible jump at the moment the
 * chunk lands — worse than an honest placeholder.
 *
 * `aria-busy` and the polite live region carry the same information to a screen reader, which
 * otherwise gets nothing at all from a purely visual shimmer.
 */
export function RouteFallback() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0' }}
    >
      {/* Page title */}
      <Skeleton height="26px" width="220px" />
      {/* Body — a few blocks at decreasing width, which reads as content without imitating any. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Skeleton height="90px" width="100%" borderRadius="10px" />
        <Skeleton height="18px" width="90%" />
        <Skeleton height="18px" width="70%" />
      </div>
    </div>
  )
}
