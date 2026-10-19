import { z } from 'zod'
import { requirementsSchema } from '../../../shared/workflow/job'
import { createJob } from '../../domain/jobs'

const body = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  requirements: requirementsSchema.default({}),
  openings: z.number().int().min(1).max(10_000).default(1),
  closesAt: z.coerce.date().nullable().default(null),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('blank') }),
    z.object({ kind: z.literal('standard_hire') }),
    z.object({ kind: z.literal('job'), jobId: z.uuid() }),
  ]).default({ kind: 'standard_hire' }),
})

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { from, ...input } = await readValidatedBody(event, body.parse)
  return domain(createJob(useDb(event), actor.user.id, input, from))
})
