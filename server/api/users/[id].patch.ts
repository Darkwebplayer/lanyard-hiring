import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { session, user } from '../../db/schema'
import { isAdminEmail } from '../../domain/access'

const body = z.object({ roleId: z.uuid().optional(), active: z.boolean().optional() })
  .refine(b => b.roleId !== undefined || b.active !== undefined, 'nothing_to_update')

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string().min(1) }).parse)
  const input = await readValidatedBody(event, body.parse)
  const db = useDb(event)

  const target = await db.query.user.findFirst({ where: eq(user.id, id) })
  if (!target) throw createError({ statusCode: 404 })
  if (isAdminEmail(target.email, useEnv(event).ADMIN_EMAIL)) {
    throw createError({ statusCode: 400, message: 'admin_is_managed_by_env' })
  }

  return db.transaction(async (tx) => {
    const [updated] = await constrained(
      tx.update(user).set({ ...input, updatedAt: new Date() }).where(eq(user.id, id)).returning(),
      { fk: 'unknown_role' },
    )
    // deactivation ends existing sessions immediately (guards also re-check on every request)
    if (input.active === false) await tx.delete(session).where(eq(session.userId, id))
    return updated
  })
})
