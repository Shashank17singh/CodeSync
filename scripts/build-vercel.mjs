import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const isInsideAppsWeb = existsSync(resolve(process.cwd(), 'src/main.tsx'))
const rootDir = isInsideAppsWeb ? resolve(process.cwd(), '../..') : process.cwd()

console.log(`Building CodeSync (working directory: ${process.cwd()}, monorepo root: ${rootDir})...`)

execSync(`pnpm --dir "${rootDir}" --filter @codesync/shared build`, { stdio: 'inherit' })
execSync(`pnpm --dir "${rootDir}" --filter @codesync/collab-client build`, { stdio: 'inherit' })
execSync(`pnpm --dir "${rootDir}" --filter @codesync/web build`, { stdio: 'inherit' })

// If running from root, sync apps/web/dist to root dist
if (!isInsideAppsWeb) {
  mkdirSync(resolve(rootDir, 'dist'), { recursive: true })
  cpSync(resolve(rootDir, 'apps/web/dist'), resolve(rootDir, 'dist'), { recursive: true })
}

console.log('Build completed successfully.')
