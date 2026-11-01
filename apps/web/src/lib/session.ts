import { create } from 'zustand'
import {
  api,
  hasSessionCookie,
  logout,
  refreshSession,
  setAccessToken,
  setSessionLostHandler,
} from './api'
import { usePreferences } from './preferences'
import type { User } from './types'

interface SessionState {
  status: 'loading' | 'signedIn' | 'signedOut'
  user: User | null
  restore: () => Promise<void>
  signIn: (accessToken: string) => Promise<void>
  signOut: () => Promise<void>
  setUser: (user: User) => void
}

export const useSession = create<SessionState>((set, get) => {
  const loadUser = async (): Promise<void> => {
    const { user } = await api<{ user: User }>('/me')
    usePreferences.getState().set({
      theme: user.theme,
      ...(user.editorSettings?.fontSize ? { fontSize: user.editorSettings.fontSize } : {}),
      ...(user.editorSettings?.tabSize ? { tabSize: user.editorSettings.tabSize } : {}),
      ...(user.editorSettings?.keybindings
        ? { keybindings: user.editorSettings.keybindings }
        : {}),
    })
    set({ status: 'signedIn', user })
  }

  return {
    status: 'loading',
    user: null,
    restore: async () => {
      try {
        if (hasSessionCookie() && (await refreshSession())) {
          await loadUser()
          return
        }
      } catch {
        // Falls through: a failed restore is the same as having no session.
      }
      set({ status: 'signedOut', user: null })
    },
    signIn: async (accessToken) => {
      setAccessToken(accessToken)
      await loadUser()
    },
    signOut: async () => {
      await logout().catch(() => undefined)
      set({ status: 'signedOut', user: null })
    },
    setUser: (user) => {
      if (get().status === 'signedIn') set({ user })
    },
  }
})

setSessionLostHandler(() => useSession.setState({ status: 'signedOut', user: null }))
