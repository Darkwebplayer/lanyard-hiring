import { z } from 'zod'
import { fileAnswer } from '../../../../domain/applications'

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id, field } = await getValidatedRouterParams(event, z.object({ id: z.uuid(), field: z.string().min(1).max(100) }).parse)
  const meta = await domain(fileAnswer(useDb(event), { userId: actor.user.id, level: actor.level }, id, field))
  const obj = await useEnv(event).CV_BUCKET.get(meta.key)
  if (!obj) throw createError({ statusCode: 404, message: 'file_not_found' })
  setResponseHeaders(event, {
    'content-type': meta.mime,
    'content-length': obj.size,
    // always a download, never rendered on our origin
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  })
  return sendStream(event, obj.body)
})
