import { z } from 'zod'
import { settings } from '../db/schema'

const body = z.object({
  companyName: z.string().trim().max(200).nullable(),
  replyToEmail: z.email().nullable(),
  consentText: z.string().max(5000).nullable(),
  aiNoticeText: z.string().max(5000).nullable(),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const input = await readValidatedBody(event, body.parse)
  const [row] = await useDb(event).insert(settings).values({ id: 1, ...input })
    .onConflictDoUpdate({ target: settings.id, set: input }).returning()
  return row
})
