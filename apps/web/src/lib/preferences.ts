import { useEffect, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type RunShortcut = 'ctrl-enter' | 'f5'

export interface Preferences {
  theme: ThemeChoice
  fontSize: number
  tabSize: number
  wordWrap: boolean
  runShortcut: RunShortcut
  set: (changes: Partial<Omit<Preferences, 'set'>>) => void
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: 'system',
      fontSize: 14,
      tabSize: 4,
      wordWrap: false,
      runShortcut: 'ctrl-enter',
      set: (changes) => set(changes),
    }),
    { name: 'codesync-preferences' },
  ),
)

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', listener)
      return () => media.removeEventListener('change', listener)
    },
    () => window.matchMedia(query).matches,
  )
}

export function useResolvedTheme(): 'light' | 'dark' {
  const choice = usePreferences((state) => state.theme)
  const systemDark = useMediaQuery(DARK_QUERY)
  if (choice === 'system') return systemDark ? 'dark' : 'light'
  return choice
}

export function useApplyTheme(): void {
  const theme = useResolvedTheme()
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])
}
