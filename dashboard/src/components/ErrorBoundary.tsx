import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Changing this (e.g. the route path) remounts the boundary and clears a caught error. */
  resetKey?: string
}
interface State {
  error: Error | null
}

/**
 * Catches render errors in the subtree so one bad page can't blank the whole app. The shell (nav,
 * top bar) lives outside this boundary and keeps working; navigating to another route clears it
 * (via `resetKey`). Without this, a single `undefined.map` unmounts everything to a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error) {
    // Surfaced in the console for diagnosis; never swallowed silently.
    console.error('Dashboard render error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{ maxInlineSize: '520px', margin: '48px auto', padding: '28px', textAlign: 'center', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-card)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>Something went wrong on this page</div>
          <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', marginBlock: '10px 20px', lineHeight: 1.5 }}>
            The rest of the dashboard is fine — try again, or pick another page from the menu.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button onClick={() => this.setState({ error: null })} style={{ padding: '9px 18px', borderRadius: '10px', border: 0, background: 'var(--accent)', color: 'var(--text-on-accent)', fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer' }}>
              Try again
            </button>
            <button onClick={() => window.location.reload()} style={{ padding: '9px 18px', borderRadius: '10px', border: '1px solid var(--border-default)', background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer' }}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
