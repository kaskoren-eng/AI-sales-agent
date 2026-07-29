import { useSyncExternalStore } from 'react'
import {
  getThemeSnapshot,
  resolveTheme,
  setThemePref,
  subscribeTheme,
  type ThemePref,
  type ResolvedTheme,
} from '../lib/theme.js'

/** React binding for the theme store. `pref` is the three-state choice; `resolved` is what is
 *  actually applied (system → light|dark). Setting `pref` persists and re-applies globally. */
export function useTheme(): { pref: ThemePref; resolved: ResolvedTheme; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  return { pref, resolved: resolveTheme(pref), setPref: setThemePref }
}
