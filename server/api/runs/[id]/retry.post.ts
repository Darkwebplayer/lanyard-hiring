import { z } from 'zod'
import { retryRun } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  await domain(retryRun(engineDeps(useEnv(event), useDb(event)), id, actor.user.id))
  return { ok: true }
})
