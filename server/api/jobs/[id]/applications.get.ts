import { z } from 'zod'
import { pipeline } from '../../../domain/applications'

const query = z.object({
  show: z.enum(['active', 'hired', 'rejected', 'withdrawn', 'all']).optional(),
  q: z.string().max(100).optional(),
  step: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  source: z.string().max(100).optional(), // exact; 'none' = unknown
})

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(pipeline(useDb(event), id, await getValidatedQuery(event, query.parse)))
})
