import { LOGO_MAX_BYTES, setLogo } from '../../domain/settings'

// Admin only: multipart `file`. Saved at once, apart from the settings form.
export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  // workerd enforces Content-Length, so requiring it caps what readFormData buffers (chunked bodies are refused)
  const length = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(length) || length <= 0) throw createError({ statusCode: 411, message: 'length_required' })
  if (length > LOGO_MAX_BYTES + 64 * 1024) throw createError({ statusCode: 413, message: 'file_too_large' })
  const body = await readFormData(event).catch(() => { throw createError({ statusCode: 400, message: 'expected_multipart' }) })
  const file = body.get('file')
  if (!file || typeof file === 'string') throw createError({ statusCode: 400, message: 'expected_file' })
  return domain(setLogo(useDb(event), useEnv(event).CV_BUCKET, new Uint8Array(await file.arrayBuffer())))
})
