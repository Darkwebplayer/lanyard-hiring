import { extractText, getDocumentProxy } from 'unpdf'
import { strFromU8, unzipSync } from 'fflate'

// A tiny zip can inflate to gigabytes (zip bomb); Workers have 128MB.
const MAX_DOCUMENT_XML = 5_000_000

export type CvMime = 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// Sniff by magic bytes, never trust the extension or the client's content-type.
export function sniffCv(bytes: Uint8Array): CvMime | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf' // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    // zip: only accept a word document whose text part has a sane size. Reads the directory only.
    let ok = false
    try {
      unzipSync(bytes, { filter: (f) => {
        if (f.name === 'word/document.xml') ok = f.originalSize <= MAX_DOCUMENT_XML
        return false
      } })
    }
    catch {}
    if (ok) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return null
}

// Returns plain text, or '' when the file has no text layer (scanned PDF) — caller fails with unreadable_cv.
export async function extractCvText(bytes: Uint8Array, mime: CvMime): Promise<string> {
  if (mime === 'application/pdf') {
    const pdf = await getDocumentProxy(bytes)
    const { text } = await extractText(pdf, { mergePages: true })
    return text.replace(/[ \t]+/g, ' ').trim()
  }
  const xml = unzipSync(bytes, { filter: f => f.name === 'word/document.xml' && f.originalSize <= MAX_DOCUMENT_XML })['word/document.xml']
  if (!xml) return ''
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim()
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
}
