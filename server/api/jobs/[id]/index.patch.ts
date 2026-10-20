import { z } from 'zod'
import { requirementsSchema } from '../../../../shared/workflow/job'
import { atLeastManager } from '../../../domain/access'
import { updateJob } from '../../../domain/jobs'

const body = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  requirements: requirementsSchema, // takes effect from the next publish
  openings: z.number().int().min(1).max(10_000),
  closesAt: z.coerce.date().nullable(),
  ownerId: z.string().min(1),
  status: z.enum(['open', 'closed', 'archived']),
}).partial().refine(b => Object.keys(b).length > 0, 'nothing_to_update')

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, body.parse)
  const db = useDb(event)
  if (input.ownerId) {
    const owner = await loadAccess(db, useEnv(event), input.ownerId)
    if (!owner || !atLeastManager(owner.level)) throw createError({ statusCode: 422, message: 'owner_must_be_manager' })
  }
  return domain(updateJob(db, id, input))
})
