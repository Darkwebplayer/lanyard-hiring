import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requirementsSchema } from '../../../../shared/workflow/job'
import { atLeastManager } from '../../../domain/access'
import { jobs } from '../../../db/schema'

const body = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  requirements: requirementsSchema,
  openings: z.number().int().min(1).max(10_000),
  closesAt: z.coerce.date().nullable(),
  ownerId: z.string().min(1),
  // 'draft' is set by creation only and 'open' needs a published version
  status: z.enum(['open', 'closed', 'archived']),
}).partial()

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, body.parse)
  const db = useDb(event)

  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, id) })
  if (!job) throw createError({ statusCode: 404 })
  if (input.status === 'open' && !job.publishedVersionId) throw createError({ statusCode: 409, message: 'publish_first' })
  if (input.ownerId) {
    const owner = await loadAccess(db, useEnv(event), input.ownerId)
    if (!owner || !atLeastManager(owner.level)) throw createError({ statusCode: 422, message: 'owner_must_be_manager' })
  }
  const [updated] = await db.update(jobs).set(input).where(eq(jobs.id, id)).returning()
  return updated
})
