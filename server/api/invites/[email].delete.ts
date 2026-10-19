import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { invites } from '../../db/schema'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { email } = await getValidatedRouterParams(event, z.object({ email: z.string().min(1) }).parse)
  const [gone] = await useDb(event).delete(invites).where(eq(invites.email, decodeURIComponent(email).toLowerCase())).returning()
  if (!gone) throw createError({ statusCode: 404 })
  return gone
})
