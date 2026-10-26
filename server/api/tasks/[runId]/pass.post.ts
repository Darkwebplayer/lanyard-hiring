import { z } from 'zod'
import { passTask } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// "Not for me": hides a task that is up for grabs from you.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { runId } = await getValidatedRouterParams(event, z.object({ runId: z.uuid() }).parse)
  return domain(passTask(engineDeps(useEnv(event), useDb(event)), runId, actor.user.id))
})
