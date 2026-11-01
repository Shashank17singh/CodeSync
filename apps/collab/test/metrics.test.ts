import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rawClient, createHarness, fileText, waitFor, type Harness } from './helpers.js'

describe('metrics', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => harness.stop())

  const scrape = async (port: number): Promise<string> =>
    (await fetch(`http://127.0.0.1:${port}/metrics`)).text()

  const value = (text: string, name: string): number =>
    Number(new RegExp(`^${name}(?:{[^}]*})? (\\S+)$`, 'm').exec(text)?.[1])

  it('reports rooms, connections and handled frames', async () => {
    const server = await harness.start()
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'typed')

    await waitFor(() => harness.hub.updates.size > 0)
    const text = await scrape(server.port)
    expect(value(text, 'codesync_collab_active_rooms')).toBe(1)
    expect(value(text, 'codesync_collab_connected_users')).toBe(1)
    expect(value(text, 'codesync_collab_frames_total')).toBeGreaterThan(0)
    expect(value(text, 'codesync_collab_frame_seconds_count')).toBeGreaterThan(0)
  })

  it('counts refused frames by reason', async () => {
    const server = await harness.start()
    const client = rawClient(server, harness.token(harness.user()))
    await waitFor(() => client.ws.readyState === client.ws.OPEN)
    client.ws.send('not binary')
    await client.closed
    expect(await scrape(server.port)).toContain('reason="not_binary"')
  })
})
