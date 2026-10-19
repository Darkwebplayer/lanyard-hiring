import { z } from 'zod'
import { roles } from '../../db/schema'

const body = z.object({ name: z.string().trim().min(1).max(80), level: z.enum(['manager', 'employee']) })

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const input = await readValidatedBody(event, body.parse)
  const [role] = await constrained(useDb(event).insert(roles).values(input).returning(), { unique: 'role_name_taken' })
  return role
})
