import { extractText, getDocumentProxy } from 'unpdf'
import { strFromU8, Unzip, UnzipInflate, unzipSync } from 'fflate'

// A tiny zip can inflate to gigabytes (zip bomb); Workers have 128MB and a CPU budget.
const MAX_DOCUMENT_XML = 5_000_000
// Stored CV text is reloaded into every context build; nobody's CV is longer than this.
const MAX_CV_TEXT = 100_000

export type CvMime = 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// Sniff by magic bytes, never trust the extension or the client's content-type.
export function sniffCv(bytes: Uint8Array): CvMime | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf' // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    // zip: only accept a word document whose text part has a sane size. Reads the directory only.
    let ok = false
    let types = false
    try {
      unzipSync(bytes, { filter: (f) => {
        if (f.name === 'word/document.xml') ok = f.originalSize <= MAX_DOCUMENT_XML
        if (f.name === '[Content_Types].xml') types = true
        return false
      } })
    }
    catch {}
    if (ok && types) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return null
}

// Returns plain text, or '' when the file has no text layer (scanned PDF) — caller fails with unreadable_cv.
export async function extractCvText(bytes: Uint8Array, mime: CvMime): Promise<string> {
  if (mime === 'application/pdf') {
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true })
    return text.replace(/[ \t]+/g, ' ').trim().slice(0, MAX_CV_TEXT)
  }
  return docxText(readDocumentXml(bytes)).slice(0, MAX_CV_TEXT)
}

// Streams word/document.xml and stops once it inflates past the cap. The size in the zip directory
// is whatever the uploader wrote, so it can't be trusted to bound the work.
function readDocumentXml(bytes: Uint8Array) {
  const parts: Uint8Array[] = []
  let size = 0
  let done = false
  const unzip = new Unzip((file) => {
    if (file.name !== 'word/document.xml') return
    file.ondata = (err, chunk, final) => {
      if (err) throw err
      size += chunk.length
      if (size > MAX_DOCUMENT_XML) throw new Error('document.xml is too large')
      parts.push(chunk)
      if (final) done = true
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  const STEP = 16_384 // 16 KB of deflate inflates to at most ~16 MB, so the cap is checked often
  for (let i = 0; i < bytes.length && !done; i += STEP) unzip.push(bytes.subarray(i, i + STEP), i + STEP >= bytes.length)
  if (!done) throw new Error('word/document.xml not found')
  const xml = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    xml.set(p, at)
    at += p.length
  }
  return xml
}

function docxText(xml: Uint8Array) {
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
