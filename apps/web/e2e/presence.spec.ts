import { randomUUID } from 'node:crypto'
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'

const SECRET = 'e2e-secret-with-at-least-32-characters'
const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const COLLAB_URL = 'ws://127.0.0.1:4199/collab'
const LABEL_FADE_MS = 3_000

interface Member {
  page: Page
  name: string
}

async function join(browser: Browser, projectId: string, name: string): Promise<Member> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const userId = randomUUID()
  const token = jwt.sign({ sub: userId, name, roomId: ROOM_ID, projectId, role: 'editor' }, SECRET, {
    algorithm: 'HS256',
    audience: 'collab',
    expiresIn: 300,
  })
  const query = new URLSearchParams({ token, userId, name, projectId, server: COLLAB_URL })
  await page.goto(`/e2e/harness/index.html?${query}`, { waitUntil: 'commit' })
  // The file buttons enable once the lazy-loaded editor exists. Unbundled Monaco is slow to load.
  await expect(fileButton(page, 'main.py')).toBeEnabled({ timeout: 60_000 })
  return { page, name }
}

const fileButton = (page: Page, path: string): Locator =>
  page.getByRole('navigation', { name: 'Files' }).getByRole('button', { name: path })

async function openFile({ page }: Member, path: string): Promise<void> {
  await fileButton(page, path).click()
  await expect(fileButton(page, path)).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.locator('.monaco-editor .view-lines').first().click()
}

const fileText = (page: Page, path: string): Promise<string> =>
  page.evaluate((target) => {
    const { tree, files } = window.harness
    for (const [id, entry] of tree.entries()) {
      if (entry.path === target) return files.get(id)?.toString() ?? ''
    }
    return ''
  }, path)

test.describe('presence in a real browser', () => {
  let projectId: string

  test.beforeEach(() => {
    projectId = randomUUID()
  })

  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((context) => context.close()))
  })

  test('shows text, a named cursor and a 25% selection from another user', async ({ browser }) => {
    const asha = await join(browser, projectId, 'Asha Rao')
    const ben = await join(browser, projectId, 'Ben Okafor')
    await openFile(asha, 'main.py')
    await openFile(ben, 'main.py')

    await asha.page.keyboard.type('print("hello")\nsecond line')
    await expect.poll(() => fileText(ben.page, 'main.py')).toBe('print("hello")\nsecond line')

    const label = ben.page.locator('.cs-label', { hasText: 'Asha Rao' })
    await expect(label).toBeVisible()
    await expect(ben.page.locator('.cs-caret')).toHaveCount(1)

    await asha.page.keyboard.press('Shift+Home')
    const selection = ben.page.locator('[class*="cs-sel-"]').first()
    await expect(selection).toBeVisible()
    const background = await selection.evaluate((node) => getComputedStyle(node).backgroundColor)
    expect(background).toMatch(/\/ 0\.25\)|, 0\.25\)/)
  })

  test('fades the name label after 3 seconds and shows it on the next move', async ({ browser }) => {
    const asha = await join(browser, projectId, 'Asha Rao')
    const ben = await join(browser, projectId, 'Ben Okafor')
    await openFile(asha, 'main.py')
    await openFile(ben, 'main.py')

    await asha.page.keyboard.type('abc')
    const label = ben.page.locator('.cs-label', { hasText: 'Asha Rao' })
    await expect(label).toHaveCSS('opacity', '1')
    await ben.page.waitForTimeout(LABEL_FADE_MS + 500)
    await expect(label).toHaveCSS('opacity', '0')

    await asha.page.keyboard.press('ArrowLeft')
    await expect(label).toHaveCSS('opacity', '1')
  })

  test('hides a cursor when its owner is in another file', async ({ browser }) => {
    const asha = await join(browser, projectId, 'Asha Rao')
    const ben = await join(browser, projectId, 'Ben Okafor')
    await openFile(asha, 'main.py')
    await openFile(ben, 'main.py')
    await asha.page.keyboard.type('x')
    await expect(ben.page.locator('.cs-caret')).toHaveCount(1)

    await openFile(asha, 'util.py')
    await expect(ben.page.locator('.cs-caret')).toHaveCount(0)
  })

  test('lists who is online and removes people who leave', async ({ browser }) => {
    const asha = await join(browser, projectId, 'Asha Rao')
    const ben = await join(browser, projectId, 'Ben Okafor')
    await openFile(ben, 'util.py')

    const row = asha.page.getByRole('button', { name: /Ben Okafor/ })
    await expect(row).toContainText('util.py')
    await expect(asha.page.getByRole('heading', { name: 'Online (2)' })).toBeVisible()

    await ben.page.context().close()
    await expect(asha.page.getByRole('heading', { name: 'Online (1)' })).toBeVisible()
  })

  test('follows a user across files until the follower types', async ({ browser }) => {
    const asha = await join(browser, projectId, 'Asha Rao')
    const ben = await join(browser, projectId, 'Ben Okafor')
    await openFile(asha, 'main.py')
    await openFile(ben, 'main.py')
    // One edit, not keystrokes: typing this at machine speed trips the server's rate limit.
    await asha.page.evaluate((text) => {
      const { tree, files } = window.harness
      for (const [id, entry] of tree.entries()) {
        if (entry.path === 'main.py') files.get(id)?.insert(0, text)
      }
    }, Array.from({ length: 80 }, (_v, i) => `line ${i}`).join('\n'))
    await expect.poll(async () => (await fileText(ben.page, 'main.py')).length).toBeGreaterThan(400)
    await asha.page.keyboard.press('Control+End')

    const row = ben.page.getByRole('button', { name: /Asha Rao/ })
    await row.click()
    await expect(row).toHaveAttribute('aria-pressed', 'true')
    await expect(fileButton(ben.page, 'main.py')).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(ben.page.locator('.view-line', { hasText: 'line 79' })).toBeVisible()

    await asha.page.keyboard.press('Control+Home')
    await expect(ben.page.locator('.view-line', { hasText: 'line 0' }).first()).toBeVisible()

    await openFile(asha, 'util.py')
    await expect(fileButton(ben.page, 'util.py')).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(row).toHaveAttribute('aria-pressed', 'true')

    await ben.page.locator('.monaco-editor .view-lines').first().click()
    await ben.page.keyboard.type('mine')
    await expect(row).toHaveAttribute('aria-pressed', 'false')

    await openFile(asha, 'main.py')
    await ben.page.waitForTimeout(300)
    await expect(fileButton(ben.page, 'util.py')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  test('keeps offline edits across a reload and syncs them on reconnect', async ({ browser }) => {
    const asha = await join(browser, projectId, 'Asha Rao')
    const ben = await join(browser, projectId, 'Ben Okafor')
    await openFile(ben, 'main.py')
    await expect.poll(() => ben.page.evaluate(() => window.harness.provider.synced)).toBe(true)

    let blocked = true
    await ben.page.routeWebSocket(/collab/, (socket) => {
      if (blocked) void socket.close()
      else socket.connectToServer()
    })
    await ben.page.evaluate(() => {
      window.harness.provider.disconnect()
    })
    await ben.page.locator('.monaco-editor .view-lines').first().click()
    await ben.page.keyboard.type('written offline')
    await expect.poll(() => fileText(ben.page, 'main.py')).toBe('written offline')
    expect(await fileText(asha.page, 'main.py')).toBe('')
    // y-indexeddb stores updates asynchronously.
    await ben.page.waitForTimeout(500)

    await ben.page.reload()
    await expect.poll(() => fileText(ben.page, 'main.py')).toBe('written offline')
    expect(await fileText(asha.page, 'main.py')).toBe('')

    // The provider's own retry reconnects, so no further reload is needed.
    blocked = false
    await expect.poll(() => fileText(asha.page, 'main.py')).toBe('written offline')
  })
})
