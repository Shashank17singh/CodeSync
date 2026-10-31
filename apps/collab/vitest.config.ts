import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@codesync/shared': fromRoot('../../packages/shared/src/index.ts'),
      '@codesync/collab-client': fromRoot('../../packages/collab-client/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    // Parallel workers abort on 8 GB machines that have other apps open.
    fileParallelism: false,
  },
})
