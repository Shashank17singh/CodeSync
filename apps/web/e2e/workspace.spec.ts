import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const PASSWORD = 'correct horse battery'
const REALISTIC_TYPING_MS = 40

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

const editorText = (page: Page) => page.getByTestId('editor').first().locator('.view-lines')

async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.getByTestId('editor').first().locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text, { delay: REALISTIC_TYPING_MS })
}

interface SharedRoom {
  alice: Page
  bob: Page
  contexts: BrowserContext[]
}

interface ShareOptions {
  bobViewport?: { width: number; height: number }
  permission?: 'Edit' | 'View'
}

async function shareRoom(
  browser: Browser,
  name: string,
  { bobViewport, permission = 'Edit' }: ShareOptions = {},
): Promise<SharedRoom> {
  const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const bobContext = await browser.newContext({
    viewport: bobViewport ?? { width: 1280, height: 800 },
  })
  const alice = await aliceContext.newPage()
  const bob = await bobContext.newPage()

  await alice.goto('/')
  await signIn(alice, 'alice@test.local')
  await alice.getByLabel('Room name').fill(name)
  await alice.getByRole('button', { name: 'Create room' }).click()
  await expect(alice.getByRole('heading', { name })).toBeVisible()
  await expect(editorText(alice)).toContainText('print')

  await alice.getByRole('button', { name: 'Share' }).click()
  await alice.getByLabel('People with the link can').selectOption({ label: permission })
  await alice.getByRole('button', { name: 'Create invite link' }).click()
  const link = await alice.getByLabel('Invite link, valid for 7 days').inputValue()
  await alice.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  // The token is in the URL fragment, which has to survive the detour through sign-in.
  await bob.goto(link)
  await signIn(bob, 'bob@test.local')
  await expect(bob.getByRole('heading', { name })).toBeVisible()
  return { alice, bob, contexts: [aliceContext, bobContext] }
}

test.describe('the workspace in two browsers', () => {
  let room: SharedRoom

  test.afterEach(async () => {
    await Promise.all(room.contexts.map((context) => context.close()))
  })

  test('two people edit one file and see each other', async ({ browser }) => {
    room = await shareRoom(browser, 'Pair session')
    const { alice, bob } = room
    await expect(editorText(bob)).toContainText('print')

    await typeInEditor(alice, 'alice_was_here')
    await expect(editorText(bob)).toContainText('alice_was_here')

    await typeInEditor(bob, 'bob_too')
    await expect(editorText(alice)).toContainText('bob_too')
    await expect(alice.getByRole('tab', { name: 'Users' })).toBeVisible()
  })

  test('chat reaches the other person, with Markdown and an unread count', async ({ browser }) => {
    room = await shareRoom(browser, 'Chat session')
    const { alice, bob } = room
    await alice.getByRole('tab', { name: 'Chat' }).click()
    await alice.getByLabel('Message').fill('Look at **this**')
    await alice.getByRole('button', { name: 'Send' }).click()

    await expect(bob.getByRole('tab', { name: 'Chat (1)' })).toBeVisible()
    await bob.getByRole('tab', { name: 'Chat (1)' }).click()
    const message = bob.getByLabel('Chat').locator('strong', { hasText: 'this' })
    await expect(message).toBeVisible()
    await expect(bob.getByRole('tab', { name: 'Chat', exact: true })).toBeVisible()
  })

  test('chat shows hostile Markdown as text', async ({ browser }) => {
    room = await shareRoom(browser, 'Hostile chat')
    const { alice, bob } = room
    await alice.getByRole('tab', { name: 'Chat' }).click()
    await bob.getByRole('tab', { name: 'Chat' }).click()
    await alice.getByLabel('Message').fill('<img src=x onerror=window.pwned=1> [x](javascript:alert(1))')
    await alice.getByRole('button', { name: 'Send' }).click()
    await expect(bob.getByLabel('Chat').locator('li').last()).toContainText('Alice')
    await expect(bob.getByLabel('Chat').locator('img')).toHaveCount(0)
    expect(await bob.evaluate(() => 'pwned' in window)).toBe(false)
    await expect(bob.getByLabel('Chat').locator('a[href^="javascript"]')).toHaveCount(0)
  })

  test('a run shows live output and its result to the whole room', async ({ browser }) => {
    room = await shareRoom(browser, 'Run session')
    const { alice, bob } = room
    await alice.getByTestId('editor').first().locator('.view-lines').click()
    await alice.keyboard.press('Control+Enter')

    for (const page of [alice, bob]) {
      await expect(page.getByTestId('terminal')).toContainText('hello from main.py')
      await expect(page.getByLabel('Run').getByRole('status')).toContainText('12 ms')
    }
  })

  test('restoring a checkpoint reaches everyone and can be undone', async ({ browser }) => {
    room = await shareRoom(browser, 'History session')
    const { alice, bob } = room
    alice.on('dialog', (dialog) => void dialog.accept())
    await alice.getByRole('tab', { name: 'History' }).click()
    await alice.getByLabel('Checkpoint name').fill('good state')
    await alice.getByRole('button', { name: 'Save' }).click()
    await expect(alice.getByLabel('History').getByText('good state')).toBeVisible()

    await typeInEditor(alice, 'broken_change')
    await expect(editorText(bob)).toContainText('broken_change')

    await alice
      .getByLabel('History')
      .getByRole('listitem')
      .filter({ hasText: 'good state' })
      .getByRole('button', { name: 'Restore project' })
      .click()
    await expect(editorText(bob)).not.toContainText('broken_change')

    await alice.getByRole('button', { name: 'Undo restore' }).click()
    await expect(editorText(bob)).toContainText('broken_change')
  })

  test('the connection badge follows the network and recovers', async ({ browser }) => {
    room = await shareRoom(browser, 'Offline session')
    const { alice, bob, contexts } = room
    const badge = (state: string) => alice.getByText(state, { exact: true })
    await expect(badge('Connected')).toBeVisible()
    await contexts[0]?.setOffline(true)
    await expect(badge('Offline')).toBeVisible()
    await typeInEditor(alice, 'typed_offline')
    await contexts[0]?.setOffline(false)
    await expect(badge('Connected')).toBeVisible({ timeout: 30_000 })
    await expect(editorText(bob)).toContainText('typed_offline', { timeout: 30_000 })
  })

  test('a viewer can watch and chat, but cannot type or run', async ({ browser }) => {
    room = await shareRoom(browser, 'Viewer session', { permission: 'View' })
    const { alice, bob } = room
    await expect(bob.getByText('viewer', { exact: true })).toBeVisible()
    await expect(editorText(bob)).toContainText('print')
    await bob.getByTestId('editor').first().locator('.view-lines').click()
    await bob.keyboard.type('nope')
    await expect(bob.getByLabel('Run').getByRole('button', { name: 'Run' })).toBeDisabled()
    await typeInEditor(alice, 'still_live')
    await expect(editorText(bob)).toContainText('still_live')
    await expect(editorText(alice)).not.toContainText('nope')
  })

  test('the file tree changes reach the other person', async ({ browser }) => {
    room = await shareRoom(browser, 'Tree session')
    const { alice, bob } = room
    await alice.getByRole('button', { name: 'New file' }).click()
    await alice.getByRole('dialog').getByLabel('Name').fill('helper.py')
    await alice.getByRole('button', { name: 'Save' }).click()
    const files = bob.getByRole('navigation', { name: 'Files' })
    await expect(files.getByRole('button', { name: 'helper.py', exact: true })).toBeVisible()

    alice.on('dialog', (dialog) => void dialog.accept())
    await alice.getByRole('navigation', { name: 'Files' }).getByText('helper.py').hover()
    await alice.getByRole('button', { name: 'Actions for helper.py' }).click()
    await alice.getByRole('menuitem', { name: 'Rename' }).click()
    await alice.getByRole('dialog').getByLabel('Name').fill('renamed.py')
    await alice.getByRole('button', { name: 'Save' }).click()
    await expect(files.getByRole('button', { name: 'renamed.py', exact: true })).toBeVisible()

    await alice.getByRole('navigation', { name: 'Files' }).getByText('renamed.py').hover()
    await alice.getByRole('button', { name: 'Actions for renamed.py' }).click()
    await alice.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(files.getByRole('button', { name: 'renamed.py', exact: true })).toHaveCount(0)
  })

  test('a comment follows its line when someone edits above it', async ({ browser }) => {
    room = await shareRoom(browser, 'Comment session')
    const { alice, bob } = room
    await typeInEditor(alice, '\nsecond_line\nthird_line')
    await expect(editorText(bob)).toContainText('third_line')
    await alice.getByRole('tab', { name: 'Comments' }).click()
    await alice.getByLabel('Comment on the selected code').fill('Check this')
    await alice.getByRole('button', { name: 'Add comment' }).click()
    const panel = alice.getByLabel('Comments')
    const before = await panel.getByRole('button', { name: /^Line \d+$/ }).innerText()
    const line = Number(before.replace('Line ', ''))
    await expect(alice.locator('.cs-glyph-comment')).toHaveCount(1)

    await bob.getByTestId('editor').first().locator('.view-lines').click()
    await bob.keyboard.press('Control+Home')
    await bob.keyboard.type('above\n', { delay: REALISTIC_TYPING_MS })
    await expect(panel.getByRole('button', { name: `Line ${line + 1}` })).toBeVisible()
  })

  test('the layout splits into two editors', async ({ browser }) => {
    room = await shareRoom(browser, 'Split session')
    const { alice } = room
    await alice.getByRole('button', { name: 'Split' }).click()
    await expect(alice.getByTestId('editor')).toHaveCount(2)
    await expect(alice.getByTestId('editor').nth(1).locator('.view-lines')).toContainText('print')
  })

  test('a phone gets read-only code and chat', async ({ browser }) => {
    room = await shareRoom(browser, 'Phone session', { bobViewport: { width: 390, height: 800 } })
    const { alice, bob } = room
    await expect(editorText(bob)).toContainText('print')
    await expect(bob.getByRole('button', { name: 'Run' })).toHaveCount(0)
    await bob.getByTestId('editor').first().locator('.view-lines').click()
    await bob.keyboard.type('nope')
    await expect(editorText(alice)).not.toContainText('nope')

    await bob.getByRole('tab', { name: 'Chat' }).click()
    await bob.getByLabel('Message').fill('from my phone')
    await bob.getByRole('button', { name: 'Send' }).click()
    await alice.getByRole('tab', { name: 'Chat' }).click()
    await expect(alice.getByLabel('Chat').getByText('from my phone')).toBeVisible()
  })

  test('the layout holds at tablet width', async ({ browser }) => {
    room = await shareRoom(browser, 'Tablet session', { bobViewport: { width: 820, height: 1100 } })
    const { bob } = room
    await expect(bob.getByRole('navigation', { name: 'Files' })).toBeVisible()
    await expect(bob.getByRole('button', { name: 'Run' })).toBeVisible()
    await expect(editorText(bob)).toContainText('print')
    const overflow = await bob.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('the pages around the workspace', () => {
  async function signedIn(browser: Browser): Promise<Page> {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto('/')
    await signIn(page, 'alice@test.local')
    await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
    return page
  }

  test('a practice problem can be filtered, opened, submitted and judged', async ({ browser }) => {
    const page = await signedIn(browser)
    await page.getByRole('link', { name: 'Practice' }).click()
    await page.getByLabel('Difficulty').selectOption('HARD')
    await expect(page.getByText('No problems match these filters.')).toBeVisible()
    await page.getByLabel('Difficulty').selectOption('EASY')
    await page.getByRole('link', { name: /Add two numbers/ }).click()

    await expect(page.locator('article strong', { hasText: 'sum' })).toBeVisible()
    await expect(page.getByTestId('practice-editor').locator('.view-lines')).toContainText('input')
    await page.getByRole('button', { name: 'Submit' }).click()
    await expect(page.getByRole('status')).toContainText('accepted')
    await expect(page.getByRole('cell', { name: '20 ms' })).toBeVisible()
    await page.context().close()
  })

  test('a contest counts down and lists its problems and standings', async ({ browser }) => {
    const page = await signedIn(browser)
    await page.getByRole('link', { name: 'Practice' }).click()
    await page.getByRole('link', { name: 'Friday contest' }).click()
    await expect(page.getByRole('timer')).toContainText(/Ends in 00:5\d:\d\d/)
    await expect(page.getByRole('link', { name: 'Add two numbers' })).toBeVisible()
    await page.context().close()
  })

  test('settings change the theme and survive a reload', async ({ browser }) => {
    const page = await signedIn(browser)
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByLabel('Theme').selectOption('dark')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.reload()
    await expect(page.getByLabel('Theme')).toHaveValue('dark')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByLabel('Theme').selectOption('light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.context().close()
  })

  test('a signed-out visitor is sent to sign in', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await context.close()
  })
})
