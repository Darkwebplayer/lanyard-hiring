import { describe, expect, it } from 'vitest'
import { LOGO_KEY, sniffLogo } from '../server/domain/settings'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('company logo', () => {
  it('knows the four image types by their bytes', () => {
    expect(sniffLogo(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]))).toBe('png')
    expect(sniffLogo(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]))).toBe('jpg')
    expect(sniffLogo(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffLogo(bytes('﻿  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg')
    expect(sniffLogo(bytes('<svg viewBox="0 0 1 1"/>'))).toBe('svg')
  })
  it('refuses anything else, whatever it is named', () => {
    expect(sniffLogo(bytes('%PDF-1.7'))).toBeNull()
    expect(sniffLogo(bytes('<html><svg></svg></html>'))).toBeNull()
    expect(sniffLogo(bytes('<?xml version="1.0"?><note/>'))).toBeNull()
    expect(sniffLogo(new Uint8Array())).toBeNull()
  })
  it('serves only keys it made', () => {
    expect(LOGO_KEY.test(`${crypto.randomUUID()}.svg`)).toBe(true)
    expect(LOGO_KEY.test('../jobs/x/cv.pdf')).toBe(false)
    expect(LOGO_KEY.test(`${crypto.randomUUID()}.html`)).toBe(false)
  })
})
