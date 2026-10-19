import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractCvText, sniffCv } from '../server/engine/handlers/extract'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))

describe('cv extraction', () => {
  it('reads pdf and docx text', async () => {
    for (const name of ['cv.pdf', 'cv.docx']) {
      const bytes = fixture(name)
      const mime = sniffCv(bytes)
      expect(mime).not.toBeNull()
      expect(await extractCvText(bytes, mime!)).toContain('6 years experience with TypeScript')
    }
  })

  it('rejects non-cv files by magic bytes', () => {
    expect(sniffCv(new TextEncoder().encode('{"not":"a cv"}'))).toBeNull()
    // a zip that is not a word document
    expect(sniffCv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBeNull()
  })
})
