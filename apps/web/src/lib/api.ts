const API_BASE = '/api/v1'
const REFRESH_LOCK = 'codesync-refresh'
const CSRF_COOKIE = 'codesync_csrf'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

// Kept in memory only, so a script injected into a page cannot read it from storage.
let accessToken: string | null = null
let refreshing: Promise<boolean> | null = null
let onSessionLost: () => void = () => undefined

export const setAccessToken = (token: string | null): void => {
  accessToken = token
}

export const setSessionLostHandler = (handler: () => void): void => {
  onSessionLost = handler
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split('; ')) {
    const separator = part.indexOf('=')
    if (part.slice(0, separator) === name) return decodeURIComponent(part.slice(separator + 1))
  }
  return null
}

export const hasSessionCookie = (): boolean => readCookie(CSRF_COOKIE) !== null

async function callRefresh(): Promise<boolean> {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': readCookie(CSRF_COOKIE) ?? '' },
  })
  if (!response.ok) return false
  const { accessToken: token } = (await response.json()) as { accessToken: string }
  accessToken = token
  return true
}

// Refresh tokens rotate with no grace window, so two tabs refreshing with the same cookie look
// like theft and both get signed out. The Web Lock makes tabs take turns: the second sends the
// cookie the first one just received.
export function refreshSession(): Promise<boolean> {
  refreshing ??= (
    navigator.locks ? navigator.locks.request(REFRESH_LOCK, callRefresh) : callRefresh()
  ).finally(() => {
    refreshing = null
  })
  return refreshing
}

async function toError(response: Response): Promise<ApiRequestError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string }
  } | null
  return new ApiRequestError(
    response.status,
    body?.error?.code ?? 'request_failed',
    body?.error?.message ?? 'Something went wrong. Try again.',
  )
}

async function send(path: string, { method = 'GET', body }: RequestOptions): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function authorised(path: string, options: RequestOptions): Promise<Response> {
  let response = await send(path, options)
  if (response.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      response = await send(path, options)
    } else {
      accessToken = null
      onSessionLost()
    }
  }
  if (!response.ok) throw await toError(response)
  return response
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await authorised(path, options)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function apiDownload(path: string, filename: string): Promise<void> {
  const blob = await (await authorised(path, {})).blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': readCookie(CSRF_COOKIE) ?? '' },
  })
  accessToken = null
}

export const errorMessage = (error: unknown): string =>
  error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.'
