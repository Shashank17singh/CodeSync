import { COLLAB_LIMITS } from '@codesync/shared'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { ApiError, invalid } from './errors.js'
import { validateProjectPath } from './paths.js'

export const ZIP_LIMITS = {
  maxArchiveBytes: 10 * 1024 * 1024,
  maxFiles: 200,
  maxExpandedBytes: 64 * 1024 * 1024,
} as const

const COMPRESSION_METHODS = new Set([0, 8])
const IGNORED_ENTRY = /(^|\/)(__MACOSX\/|\.DS_Store$)/

export interface ArchiveFile {
  path: string
  content: string
}

export function readProjectArchive(archive: Uint8Array): ArchiveFile[] {
  let entries = 0
  let expandedBytes = 0
  const paths: string[] = []

  const accept = (file: { name: string; originalSize: number; compression: number }): boolean => {
    if (IGNORED_ENTRY.test(file.name)) return false
    if (file.name.endsWith('/')) {
      validateProjectPath(file.name.slice(0, -1))
      return false
    }
    // All of this runs before inflating, so a hostile archive costs nothing to refuse.
    entries += 1
    if (entries > ZIP_LIMITS.maxFiles) {
      throw invalid('too_many_files', `An archive can hold at most ${ZIP_LIMITS.maxFiles} files`)
    }
    expandedBytes += file.originalSize
    if (expandedBytes > ZIP_LIMITS.maxExpandedBytes) {
      throw invalid('archive_too_large', 'The archive expands to too much data')
    }
    if (!COMPRESSION_METHODS.has(file.compression)) {
      throw invalid('invalid_archive', 'The archive uses an unsupported compression method')
    }
    paths.push(validateProjectPath(file.name))
    return true
  }

  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(archive, { filter: accept })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw invalid('invalid_archive', 'The file is not a valid zip archive')
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  return Object.entries(unzipped).map(([name, bytes]) => {
    let content: string
    try {
      content = decoder.decode(bytes)
    } catch {
      // File content lives in a Y.Text, which cannot hold binary data.
      throw invalid('binary_file', `${name.slice(0, 120)} is not a UTF-8 text file`)
    }
    if (content.length > COLLAB_LIMITS.maxFileChars) {
      throw invalid('file_too_large', `${name.slice(0, 120)} is larger than the 2 MB limit`)
    }
    return { path: validateProjectPath(name), content }
  })
}

export function writeProjectArchive(files: ArchiveFile[]): Uint8Array {
  const entries: Zippable = {}
  for (const file of files) entries[file.path] = strToU8(file.content)
  return zipSync(entries)
}
