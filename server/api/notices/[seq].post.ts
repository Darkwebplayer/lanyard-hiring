import { z } from 'zod'
import { markNotice } from '../../domain/notices'

// One item opened (read), or dismissed: true to take it off the tray.
export default defineEventHandler(async (event) => {
  const { user } = await requireUser(event)
  const { seq } = await getValidatedRouterParams(event, z.object({ seq: z.coerce.number().int().positive() }).parse)
  const { dismissed } = await readValidatedBody(event, z.object({ dismissed: z.boolean().default(false) }).parse)
  return markNotice(useDb(event), user.id, seq, dismissed)
})
