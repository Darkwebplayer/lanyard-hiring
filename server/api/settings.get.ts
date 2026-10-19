import { settings } from '../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const [row] = await useDb(event).select().from(settings)
  return row ?? { id: 1, replyToEmail: null, consentText: null, aiNoticeText: null }
})
