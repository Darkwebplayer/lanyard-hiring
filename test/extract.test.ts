import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractCvText, sniffCv } from '../server/engine/handlers/extract'
import { cleanList } from '../server/engine/handlers'

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

describe('docx safety (review regressions)', () => {
  const docx = (xml: string | Uint8Array) => zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': typeof xml === 'string' ? strToU8(xml) : xml })

  it('refuses a zip bomb without inflating it', () => {
    expect(sniffCv(docx('a'.repeat(6_000_000)))).toBeNull()
  })

  it('decodes numeric entities and line breaks', async () => {
    const bytes = docx('<w:p><w:r><w:t>it&#x2019;s</w:t><w:br/><w:t>&#8364;5</w:t></w:r></w:p>')
    expect(await extractCvText(bytes, sniffCv(bytes)!)).toBe('it’s\n€5')
  })

  // review round 2
  it('a zip with a word/document.xml entry but no [Content_Types].xml is not a docx', () => {
    expect(sniffCv(zipSync({ 'word/document.xml': strToU8('<script>x</script>') }))).toBeNull()
  })

  it('stops inflating a bomb that lies about its size in the zip directory', async () => {
    const bomb = docx(new Uint8Array(60_000_000).fill(65))
    const dv = new DataView(bomb.buffer)
    // rewrite the uncompressed size of word/document.xml in the local header and central directory to 1000
    for (let i = 0; i < bomb.length - 4; i++) {
      const name = (at: number, lenAt: number) => new TextDecoder().decode(bomb.subarray(at, at + dv.getUint16(lenAt, true)))
      if (dv.getUint32(i, true) === 0x04034B50 && name(i + 30, i + 26) === 'word/document.xml') dv.setUint32(i + 22, 1000, true)
      if (dv.getUint32(i, true) === 0x02014B50 && name(i + 46, i + 28) === 'word/document.xml') dv.setUint32(i + 24, 1000, true)
    }
    expect(sniffCv(bomb)).not.toBeNull() // the directory looks innocent
    await expect(extractCvText(bomb, sniffCv(bomb)!)).rejects.toThrow('too large')
  })

  it('caps extracted text', async () => {
    const bytes = docx(`<w:p><w:t>${'word '.repeat(50_000)}</w:t></w:p>`)
    expect((await extractCvText(bytes, sniffCv(bytes)!)).length).toBe(100_000)
  })
})

describe('cv list cleanup', () => {
  it('rejoins and drops sub-word pieces Clairic returns (QA, Nurul)', () => {
    const text = 'Led ops on Manhattan WMS. WSQ OSH. Defensive Driving Course. Advanced Excel (SkillsFuture). SKILLS: English, C'
    expect(cleanList(['Manhattan WMS', 'M', 'Excel', 'F', 'WS', 'Advanced', 'Man', 'hattan WMS', 'Def', 'ensive Driving Course', 'English,', 'SK', 'C', 'Team coaching'], text))
      .toEqual(['Manhattan WMS', 'Excel', 'Advanced', 'Defensive Driving Course', 'English', 'C', 'Team coaching'])
  })

  it('keeps stems, rejoins across line breaks, drops empties', () => {
    const text = 'Drove forklifts daily. ReactJS and Python3.\nManhattan\nWMS, Defensive\nDriving Course'
    expect(cleanList(['Forklift', 'React', 'Python', ',', 'Man', 'hattan WMS', 'Def', 'ensive Driving Course'], text))
      .toEqual(['Forklift', 'React', 'Python', 'Manhattan WMS', 'Defensive Driving Course'])
  })
})
