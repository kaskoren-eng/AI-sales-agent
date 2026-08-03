/**
 * Theme preference — brief v5 §2.1. Three-state (light / dark / system), resolved to
 * `data-theme` on <html>. `system` follows `prefers-color-scheme` live. Persisted per user
 * in localStorage. The canonical control is Settings › Profile › Appearance; other surfaces
 * (e.g. a shell toggle) read/write through here so there is one source of truth.
 */

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'keren.theme'
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#EDF0F6', dark: '#0A0F20' }

const media = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

const listeners = new Set<() => void>()

function isPref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'system'
}

export function getThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isPref(stored)) return stored
  } catch {
    /* localStorage unavailable (private mode, SSR) — fall back to system */
  }
  return 'system'
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'system') return media()?.matches ? 'dark' : 'light'
  return pref
}

/** Apply the resolved theme to <html> and keep the theme-color meta in sync. */
function applyResolved(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved])
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    /* ignore write failures */
  }
  applyResolved(resolveTheme(pref))
  listeners.forEach((l) => l())
}

/** Call once at boot: apply stored preference and track system changes while on `system`. */
export function initTheme(): void {
  applyResolved(resolveTheme(getThemePref()))
  const mq = media()
  mq?.addEventListener('change', () => {
    if (getThemePref() === 'system') {
      applyResolved(resolveTheme('system'))
      listeners.forEach((l) => l())
    }
  })
}

/* --- useSyncExternalStore plumbing for React consumers --- */
export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export function getThemeSnapshot(): ThemePref {
  return getThemePref()
}
