import { z } from 'zod'
import { documentFile } from '../../../../domain/documents'

// Same headers as the application's own files: always a download, never rendered on our origin.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id, index } = await getValidatedRouterParams(event, z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) }).parse)
  const meta = await domain(documentFile(useDb(event), { userId: actor.user.id, level: actor.level }, id, index))
  const obj = await useEnv(event).CV_BUCKET.get(meta.key)
  if (!obj) throw createError({ statusCode: 404, message: 'file_not_found' })
  setResponseHeaders(event, {
    'content-type': meta.mime,
    'content-length': obj.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  })
  return sendStream(event, obj.body)
})
