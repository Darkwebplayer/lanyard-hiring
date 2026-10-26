import { z } from 'zod'
import { markNotices } from '../../domain/notices'

// seen: the tray was opened up to this event; cleared: Clear all, up to this event.
const body = z.object({ seen: z.number().int().nonnegative().optional(), cleared: z.number().int().nonnegative().optional() })

export default defineEventHandler(async (event) => {
  const { user } = await requireUser(event)
  return markNotices(useDb(event), user.id, await readValidatedBody(event, body.parse))
})
