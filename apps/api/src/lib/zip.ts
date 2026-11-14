import { COLLAB_LIMITS } from '@codesync/shared'
import { Unzip, UnzipInflate, strToU8, zipSync, type Zippable } from 'fflate'
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

export interface ArchiveEntry {
  name: string
  compression: number
  originalSize: number
}

const PUSH_BYTES = 16 * 1024

const tooLarge = (): ApiError => invalid('archive_too_large', 'The archive expands to too much data')

// Counts the bytes actually inflated. Sizes in the zip headers are written by the uploader, and
// the decompressor does not hold an entry to its declared size, so they cannot bound the work.
export function unzipBounded(
  archive: Uint8Array,
  accept: (entry: ArchiveEntry) => boolean,
): Record<string, Uint8Array> {
  if (!looksLikeZip(archive)) throw invalid('invalid_archive', 'The file is not a valid zip archive')
  const files: Record<string, Uint8Array> = {}
  let expandedBytes = 0
  let failure: unknown = null
  const unzip = new Unzip((file) => {
    if (failure) return
    try {
      if (!accept({ ...file, originalSize: file.originalSize ?? 0 })) return
    } catch (error) {
      failure = error
      return
    }
    const chunks: Uint8Array[] = []
    file.ondata = (error, chunk, final) => {
      if (failure) return
      if (error) {
        failure = error
        return
      }
      expandedBytes += chunk.length
      if (expandedBytes > ZIP_LIMITS.maxExpandedBytes) {
        failure = tooLarge()
        return
      }
      chunks.push(chunk)
      if (final) files[file.name] = concat(chunks)
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  // Small slices keep each inflate step small, so work stops soon after the limit is passed.
  try {
    for (let offset = 0; offset < archive.length && !failure; offset += PUSH_BYTES) {
      const end = Math.min(offset + PUSH_BYTES, archive.length)
      unzip.push(archive.subarray(offset, end), end === archive.length)
    }
  } catch (error) {
    failure ??= error
  }
  if (failure instanceof ApiError) throw failure
  if (failure) throw invalid('invalid_archive', 'The file is not a valid zip archive')
  return files
}

// The streaming reader skips bytes it does not recognise, so it would read junk as an empty zip.
// A zip starts with an entry header (or the end record, when empty) and ends with an end record.
function looksLikeZip(archive: Uint8Array): boolean {
  if (archive.length < 22) return false
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const first = view.getUint32(0, true)
  if (first !== 0x04034b50 && first !== 0x06054b50) return false
  // The end record is 22 bytes plus a comment of at most 65535 bytes.
  const stop = Math.max(0, archive.length - 22 - 0xffff)
  for (let offset = archive.length - 22; offset >= stop; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return true
  }
  return false
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function readProjectArchive(archive: Uint8Array): ArchiveFile[] {
  let entries = 0
  let declaredBytes = 0

  const accept = (file: ArchiveEntry): boolean => {
    if (IGNORED_ENTRY.test(file.name)) return false
    if (file.name.endsWith('/')) {
      validateProjectPath(file.name.slice(0, -1))
      return false
    }
    // Declared sizes refuse an honest oversized archive early; unzipBounded catches a lying one.
    entries += 1
    if (entries > ZIP_LIMITS.maxFiles) {
      throw invalid('too_many_files', `An archive can hold at most ${ZIP_LIMITS.maxFiles} files`)
    }
    declaredBytes += file.originalSize
    if (declaredBytes > ZIP_LIMITS.maxExpandedBytes) throw tooLarge()
    if (!COMPRESSION_METHODS.has(file.compression)) {
      throw invalid('invalid_archive', 'The archive uses an unsupported compression method')
    }
    validateProjectPath(file.name)
    return true
  }

  const unzipped = unzipBounded(archive, accept)

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
