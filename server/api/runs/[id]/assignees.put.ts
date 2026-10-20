import { z } from 'zod'
import { reassignTask } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

const ids = z.array(z.string().min(1)).max(50).default([])
const body = z.object({ add: ids, remove: ids }).refine(b => b.add.length + b.remove.length > 0, 'nothing_to_change')

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const change = await readValidatedBody(event, body.parse)
  return domain(reassignTask(engineDeps(useEnv(event), useDb(event)), id, change, actor.user.id))
})
