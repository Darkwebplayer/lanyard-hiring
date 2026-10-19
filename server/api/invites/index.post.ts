import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { invites, user } from '../../db/schema'
import { isAdminEmail } from '../../domain/access'

const body = z.object({ email: z.email().transform(e => e.trim().toLowerCase()), roleId: z.uuid() })

export default defineEventHandler(async (event) => {
  const actor = await requireAdmin(event)
  const { email, roleId } = await readValidatedBody(event, body.parse)
  if (isAdminEmail(email, useEnv(event).ADMIN_EMAIL)) throw createError({ statusCode: 400, message: 'admin_is_managed_by_env' })

  const db = useDb(event)
  if (await db.query.user.findFirst({ where: eq(user.email, email) })) {
    throw createError({ statusCode: 409, message: 'user_exists' })
  }
  // re-inviting the same email just changes the role
  const [invite] = await constrained(
    db.insert(invites).values({ email, roleId, invitedBy: actor.user.id })
      .onConflictDoUpdate({ target: invites.email, set: { roleId, invitedBy: actor.user.id } })
      .returning(),
    { fk: 'unknown_role' },
  )
  return invite
})
