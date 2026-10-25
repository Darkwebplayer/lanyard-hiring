import { z } from 'zod'
import { uploadDocument } from '../../../domain/documents'
import { engineDeps } from '../../../engine/worker'

const MAX_BODY = 11 * 1024 * 1024 // one 10 MB file plus the field

// No auth: multipart `index` (which document) and `file`. The checks are the apply page's: length first, then magic bytes.
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  // workerd enforces Content-Length, so requiring it caps what readFormData buffers (chunked bodies are refused)
  const length = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(length) || length <= 0) throw createError({ statusCode: 411, message: 'length_required' })
  if (length > MAX_BODY) throw createError({ statusCode: 413, message: 'file_too_large' })
  const body = await readFormData(event).catch(() => { throw createError({ statusCode: 400, message: 'expected_multipart' }) })
  const index = z.coerce.number().int().min(0).safeParse(body.get('index'))
  const file = body.get('file')
  if (!index.success || !file || typeof file === 'string') throw createError({ statusCode: 400, message: 'expected_file' })
  const env = useEnv(event)
  const db = useDb(event)
  return domain(uploadDocument(engineDeps(env, db), env.CV_BUCKET, token, index.data, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }))
})
