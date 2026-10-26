import { z } from 'zod'
import { claimTask } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// "Take it": the task becomes yours; once enough people have taken it, everyone else is let go.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { runId } = await getValidatedRouterParams(event, z.object({ runId: z.uuid() }).parse)
  return domain(claimTask(engineDeps(useEnv(event), useDb(event)), runId, actor.user.id))
})
