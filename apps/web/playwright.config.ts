import { defineConfig } from '@playwright/test'

// E2E_PRODUCTION=1 serves the real production bundle, which can differ from the dev server.
const webCommand = process.env['E2E_PRODUCTION']
  ? 'corepack pnpm exec vite build && corepack pnpm exec vite preview --host 127.0.0.1 --port 5199 --strictPort'
  : 'corepack pnpm exec vite --host 127.0.0.1 --port 5199 --strictPort'
const webUrl = process.env['E2E_PRODUCTION']
  ? 'http://127.0.0.1:5199/login'
  : 'http://127.0.0.1:5199/e2e/harness/index.html'

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'corepack pnpm exec tsx test/e2eServer.ts',
      cwd: '../collab',
      port: 4199,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'corepack pnpm exec tsx test/e2eStack.ts',
      cwd: '../api',
      port: 4200,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: webCommand,
      url: webUrl,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        VITE_API_TARGET: 'http://127.0.0.1:4200',
        VITE_COLLAB_TARGET: 'http://127.0.0.1:4201',
      },
    },
  ],
})
