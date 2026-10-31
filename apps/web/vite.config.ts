import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@codesync/shared', replacement: fromRoot('../../packages/shared/src/index.ts') },
      {
        find: '@codesync/collab-client',
        replacement: fromRoot('../../packages/collab-client/src/index.ts'),
      },
      // y-monaco still imports the path that monaco-editor 0.57 removed from its exports.
      { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: 'monaco-editor/$1' },
    ],
    // One copy only: two instances of Yjs corrupt documents silently.
    dedupe: ['yjs', 'y-protocols', 'lib0'],
  },
  optimizeDeps: {
    // Pre-bundling Monaco runs the dev server out of memory on 8 GB machines.
    exclude: ['monaco-editor', 'y-monaco'],
  },
})
