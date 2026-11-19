import { execSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'

console.log('Building shared, collab-client, and web...')
execSync('pnpm --filter @codesync/shared build', { stdio: 'inherit' })
execSync('pnpm --filter @codesync/collab-client build', { stdio: 'inherit' })
execSync('pnpm --filter @codesync/web build', { stdio: 'inherit' })

console.log('Syncing bundle to root dist...')
mkdirSync('dist', { recursive: true })
cpSync('apps/web/dist', 'dist', { recursive: true })
console.log('Build completed successfully.')
