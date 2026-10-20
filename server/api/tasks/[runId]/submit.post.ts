import { z } from 'zod'
import { submitTask } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// Body: the scorecard values; validated against the task's pinned scorecard by the engine.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { runId } = await getValidatedRouterParams(event, z.object({ runId: z.uuid() }).parse)
  const { values } = await readValidatedBody(event, z.object({ values: z.record(z.string(), z.unknown()) }).parse)
  return domain(submitTask(engineDeps(useEnv(event), useDb(event)), runId, actor.user.id, values))
})
