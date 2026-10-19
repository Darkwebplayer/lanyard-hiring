import { extractCvText, sha256Hex, sniffCv } from '../../engine/handlers/extract'

// Phase 0 spike: raw file body in, text out, plus an R2 write. Delete after phase 0.
export default defineEventHandler(async (event) => {
  const bytes = new Uint8Array((await readRawBody(event, false))!)
  const mime = sniffCv(bytes)
  if (!mime) throw createError({ statusCode: 400, message: 'not a pdf/docx' })
  const sha256 = await sha256Hex(bytes)
  const key = `spike/${crypto.randomUUID()}`
  await useEnv(event).CV_BUCKET.put(key, bytes, { httpMetadata: { contentType: mime }, sha256 })
  return { mime, sha256, key, text: (await extractCvText(bytes, mime)).slice(0, 200) }
})
