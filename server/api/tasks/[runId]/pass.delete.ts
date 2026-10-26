import { z } from 'zod'
import { unpassTask } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// Undo "Not for me", while nobody has taken the task yet.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { runId } = await getValidatedRouterParams(event, z.object({ runId: z.uuid() }).parse)
  return domain(unpassTask(engineDeps(useEnv(event), useDb(event)), runId, actor.user.id))
})
