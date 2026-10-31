import { invalid } from './errors.js'

const MAX_PATH_LENGTH = 1024
const MAX_SEGMENT_LENGTH = 255
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const DRIVE_PREFIX = /^[a-zA-Z]:/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

// Paths end up on disk in execution sandboxes (3.5), so anything that could leave the project
// root is rejected here instead of being cleaned up. Silently rewriting `../a` to `a` would hide
// the attack and could overwrite a different file.
export function validateProjectPath(raw: string): string {
  const reject = (): never => {
    throw invalid('invalid_path', `Invalid file path: ${JSON.stringify(raw.slice(0, 120))}`)
  }

  const path = raw.normalize('NFC')
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) reject()
  if (CONTROL_CHARACTERS.test(path)) reject()
  // A backslash is a separator on Windows, so `..\evil` traverses there and not on Linux.
  if (path.includes('\\')) reject()
  if (path.startsWith('/') || DRIVE_PREFIX.test(path)) reject()

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') reject()
    if (segment.length > MAX_SEGMENT_LENGTH) reject()
    if (segment.endsWith('.') || segment.endsWith(' ')) reject()
    if (WINDOWS_RESERVED.test(segment)) reject()
  }
  return path
}

export function parentPaths(path: string): string[] {
  const segments = path.split('/')
  return segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'))
}

export const isInside = (path: string, directory: string): boolean =>
  path.startsWith(`${directory}/`)
