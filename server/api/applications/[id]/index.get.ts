import { z } from 'zod'
import { timeline } from '../../../domain/applications'

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(timeline(useDb(event), { userId: actor.user.id, level: actor.level }, id, new Date()))
})
