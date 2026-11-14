import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ZIP_LIMITS, readProjectArchive } from '../src/lib/zip.js'
import { readTestArchive } from '../src/modules/problems.js'

// Rewrites every declared uncompressed size to 1 byte, as a hostile archive would.
function lieAboutSizes(archive: Uint8Array): Uint8Array {
  const out = archive.slice()
  const view = new DataView(out.buffer)
  for (let offset = 0; offset + 4 <= out.length; offset++) {
    const signature = view.getUint32(offset, true)
    if (signature === 0x04034b50) view.setUint32(offset + 22, 1, true)
    if (signature === 0x02014b50) view.setUint32(offset + 24, 1, true)
  }
  return out
}

const tooMuch = (): Uint8Array => new Uint8Array(ZIP_LIMITS.maxExpandedBytes + 1024)

describe('archive limits count real bytes, not declared ones', () => {
  it('refuses a project archive that lies about how much it expands to', () => {
    const archive = lieAboutSizes(zipSync({ 'big.txt': tooMuch() }, { level: 9 }))
    expect(archive.length).toBeLessThan(ZIP_LIMITS.maxArchiveBytes)
    expect(() => readProjectArchive(archive)).toThrow(/expands to too much data/)
  })

  it('refuses a test archive that lies about how much it expands to', () => {
    const archive = lieAboutSizes(
      zipSync({ '1.in': tooMuch(), '1.out': new Uint8Array(1) }, { level: 9 }),
    )
    expect(() => readTestArchive(archive)).toThrow(/expands to too much data/)
  })

  it('still reads an honest archive', () => {
    const archive = zipSync({ 'src/main.py': new TextEncoder().encode('print(1)\n') })
    expect(readProjectArchive(archive)).toEqual([{ path: 'src/main.py', content: 'print(1)\n' }])
  })
})
