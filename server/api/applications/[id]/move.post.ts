import { z } from 'zod'
import { moveApplication } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// Jump to a node (reopens a closed application) or close directly. Reason, reason code and the
// target stage's answers go in the event log; moveApplication checks which are required.
const body = z.object({
  to: z.union([z.object({ node: z.string().min(1) }), z.object({ close: z.enum(['hired', 'rejected', 'withdrawn']) })]),
  reason: z.string().trim().max(1000).optional(),
  reasonCode: z.string().trim().max(60).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const { to, ...input } = await readValidatedBody(event, body.parse)
  await domain(moveApplication(engineDeps(useEnv(event), useDb(event)), id, to, input, actor.user.id))
  return { ok: true }
})
