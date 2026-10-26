import { z } from 'zod'
import { listSchedule } from '../domain/tasks'

// ?from&to (ISO, at most 6 weeks apart) and everyone=1 for the whole team (managers).
const query = z.object({ from: z.coerce.date(), to: z.coerce.date(), everyone: z.literal('1').optional() })
  .refine(q => q.to > q.from && q.to.getTime() - q.from.getTime() <= 42 * 86_400_000, 'bad_range')

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const q = await getValidatedQuery(event, query.parse)
  return domain(listSchedule(useDb(event), { userId: actor.user.id, level: actor.level }, q.from, q.to, !!q.everyone, new Date()))
})
