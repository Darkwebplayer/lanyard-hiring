import { z } from 'zod'
import { markReceived } from '../../../domain/documents'
import { engineDeps } from '../../../engine/worker'

const body = z.object({ index: z.number().int().min(0), note: z.string().max(500).optional() })

// "Mark received…": a document handed over in person or by email.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const { index, note } = await readValidatedBody(event, body.parse)
  const db = useDb(event)
  return domain(markReceived(engineDeps(useEnv(event), db), { userId: actor.user.id, level: actor.level }, { id: actor.user.id, name: actor.user.name }, id, index, note))
})
