import { z } from 'zod'
import { getTask } from '../../../domain/tasks'

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { runId } = await getValidatedRouterParams(event, z.object({ runId: z.uuid() }).parse)
  return domain(getTask(useDb(event), { userId: actor.user.id, level: actor.level }, runId, new Date()))
})
