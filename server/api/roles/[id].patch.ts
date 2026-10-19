import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { roles } from '../../db/schema'

const body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  level: z.enum(['manager', 'employee']).optional(),
}).refine(b => b.name || b.level, 'nothing_to_update')

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, body.parse)
  const [role] = await constrained(
    useDb(event).update(roles).set(input).where(eq(roles.id, id)).returning(),
    { unique: 'role_name_taken' },
  )
  if (!role) throw createError({ statusCode: 404 })
  return role
})
