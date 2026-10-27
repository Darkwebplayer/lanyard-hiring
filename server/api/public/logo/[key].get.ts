import { LOGO_KEY } from '../../../domain/settings'

// No auth: the employer's logo on the candidate pages. Only logo/ objects, by a key that changes on every upload.
export default defineEventHandler(async (event) => {
  const key = getRouterParam(event, 'key') ?? ''
  if (!LOGO_KEY.test(key)) throw createError({ statusCode: 404, message: 'not_found' })
  const obj = await useEnv(event).CV_BUCKET.get(`logo/${key}`)
  if (!obj) throw createError({ statusCode: 404, message: 'not_found' })
  setResponseHeaders(event, {
    'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-length': obj.size,
    'x-content-type-options': 'nosniff',
    // an SVG opened on its own must not run scripts on our origin
    'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox',
    'cache-control': 'public, max-age=31536000, immutable',
  })
  return sendStream(event, obj.body)
})
