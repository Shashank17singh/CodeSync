import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, refreshSession, setAccessToken, setSessionLostHandler } from './api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    setAccessToken('expired')
  })
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
    setSessionLostHandler(() => undefined)
  })

  const authorisations = (): Array<string | undefined> =>
    fetchMock.mock.calls
      .filter(([url]) => !String(url).includes('/auth/refresh'))
      .map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['authorization'])

  it('refreshes once on a 401 and repeats the request with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { accessToken: 'fresh' }))
      .mockResolvedValueOnce(json(200, { ok: true }))
    await expect(api('/me')).resolves.toEqual({ ok: true })
    expect(authorisations()).toEqual(['Bearer expired', 'Bearer fresh'])
  })

  it('shares one refresh between requests that fail together', async () => {
    let finishRefresh: (response: Response) => void = () => undefined
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes('/auth/refresh')) {
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve
        })
      }
      const header = ((init as RequestInit).headers as Record<string, string>)['authorization']
      return header === 'Bearer fresh' ? json(200, { ok: true }) : json(401, {})
    })
    const requests = [api('/a'), api('/b'), api('/c')]
    const refreshCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/refresh'))
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1))
    finishRefresh(json(200, { accessToken: 'fresh' }))
    await Promise.all(requests)
    expect(refreshCalls()).toHaveLength(1)
  })

  it('takes the shared Web Lock, so two tabs cannot refresh at once', async () => {
    const request = vi.fn((_name: string, task: () => Promise<boolean>) => task())
    vi.stubGlobal('navigator', { locks: { request } })
    fetchMock.mockResolvedValueOnce(json(200, { accessToken: 'fresh' }))
    await refreshSession()
    expect(request).toHaveBeenCalledWith('codesync-refresh', expect.any(Function))
  })

  it('reports a lost session when the refresh fails', async () => {
    const lost = vi.fn()
    setSessionLostHandler(lost)
    fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(401, {}))
    await expect(api('/me')).rejects.toMatchObject({ status: 401 })
    expect(lost).toHaveBeenCalledOnce()
  })

  it('does not try to refresh after a failed sign-in', async () => {
    fetchMock.mockResolvedValueOnce(
      json(401, { error: { code: 'invalid_credentials', message: 'Wrong email or password' } }),
    )
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'invalid_credentials',
      message: 'Wrong email or password',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
