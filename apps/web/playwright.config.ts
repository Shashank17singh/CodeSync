import { defineConfig } from '@playwright/test'

// E2E_PORT_OFFSET moves every server, so a run can avoid ports held by something else.
const offset = Number(process.env['E2E_PORT_OFFSET'] ?? 0)
const presencePort = 4199 + offset
const apiPort = 4200 + offset
const collabPort = 4201 + offset
const webPort = 5199 + offset
const webOrigin = `http://127.0.0.1:${webPort}`

// E2E_PRODUCTION=1 serves the real production bundle, which can differ from the dev server.
const webCommand = process.env['E2E_PRODUCTION']
  ? 'corepack pnpm exec vite build && corepack pnpm exec vite preview --host 127.0.0.1 --port ' + webPort + ' --strictPort'
  : `corepack pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`
const webUrl = process.env['E2E_PRODUCTION']
  ? `${webOrigin}/login`
  : `${webOrigin}/e2e/harness/index.html`

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: webOrigin,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'corepack pnpm exec tsx test/e2eServer.ts',
      cwd: '../collab',
      port: presencePort,
      env: { E2E_COLLAB_PORT: String(presencePort), E2E_ORIGIN: webOrigin },
      // Never reused: a server left over from an earlier run would test old code.
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'corepack pnpm exec tsx test/e2eStack.ts',
      cwd: '../api',
      port: apiPort,
      env: {
        E2E_API_PORT: String(apiPort),
        E2E_COLLAB_PORT: String(collabPort),
        E2E_WEB_ORIGIN: webOrigin,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: webCommand,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`,
        VITE_COLLAB_TARGET: `http://127.0.0.1:${collabPort}`,
      },
    },
  ],
})
