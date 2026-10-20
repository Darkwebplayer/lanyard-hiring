import { z } from 'zod'
import { moveApplication } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// Jump to a node (reopens a closed application) or close directly. The reason goes in the event log.
const body = z.object({
  to: z.union([z.object({ node: z.string().min(1) }), z.object({ close: z.enum(['hired', 'rejected', 'withdrawn']) })]),
  reason: z.string().trim().min(1).max(1000),
})

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const { to, reason } = await readValidatedBody(event, body.parse)
  await domain(moveApplication(engineDeps(useEnv(event), useDb(event)), id, to, reason, actor.user.id))
  return { ok: true }
})
