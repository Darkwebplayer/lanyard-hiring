import { z } from 'zod'
import { recordAnswer, recordedAnswer } from '../../../domain/offers'
import { engineDeps } from '../../../engine/worker'

// Record their answer: it came by phone, email or in person. Same effect as the candidate's link.
export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, recordedAnswer.parse)
  return domain(recordAnswer(engineDeps(useEnv(event), useDb(event)), id, input, { id: actor.user.id, name: actor.user.name }))
})
