import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

// `vite preview` serves the bundle under the policy Nginx uses, so tests cover that policy too.
const nginxTemplate = readFileSync(fromRoot('../../infra/nginx/codesync.conf.template'), 'utf8')
const contentSecurityPolicy = /Content-Security-Policy "([^"]+)"/.exec(nginxTemplate)?.[1] ?? ''

const apiTarget = process.env['VITE_API_TARGET'] ?? 'http://127.0.0.1:3000'
const collabTarget = process.env['VITE_COLLAB_TARGET'] ?? 'http://127.0.0.1:4000'

// monaco-emacs's source uses `import x = require()`, which only a production bundle can run.
const monacoEmacsImports: Plugin = {
  name: 'monaco-emacs-imports',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('monaco-emacs/src/emacs/index.ts')) return null
    return code.replace(/import (\w+) =\s*require\('([^']+)'\);/g, "import $1 from '$2';")
  },
}

export default defineConfig({
  plugins: [monacoEmacsImports, react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: apiTarget },
      '/collab': { target: collabTarget, ws: true },
    },
  },
  resolve: {
    alias: [
      { find: '@codesync/shared', replacement: fromRoot('../../packages/shared/src/index.ts') },
      {
        find: '@codesync/collab-client',
        replacement: fromRoot('../../packages/collab-client/src/index.ts'),
      },
      // Its CommonJS build would load Monaco's AMD bundle, so this uses the package's own source.
      { find: /^monaco-emacs$/, replacement: fromRoot('node_modules/monaco-emacs/src/index.ts') },
      // The package's browser entry is a UMD file with no named exports.
      { find: /^monaco-vim$/, replacement: fromRoot('node_modules/monaco-vim/dist/index.mjs') },
      // y-monaco still imports the path that monaco-editor 0.57 removed from its exports.
      { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: 'monaco-editor/$1' },
    ],
    // One copy only: two instances of Yjs corrupt documents silently.
    dedupe: ['yjs', 'y-protocols', 'lib0'],
  },
  preview: {
    headers: { 'Content-Security-Policy': contentSecurityPolicy },
  },
  optimizeDeps: {
    // Pre-bundling Monaco runs the dev server out of memory on 8 GB machines.
    exclude: ['monaco-editor', 'y-monaco', 'monaco-vim', 'monaco-emacs'],
    include: ['monaco-emacs > lodash.throttle', 'monaco-emacs > lodash.kebabcase'],
  },
})
