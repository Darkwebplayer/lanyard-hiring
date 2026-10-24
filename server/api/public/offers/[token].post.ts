import { z } from 'zod'
import { offerResponse, respondToOffer } from '../../../domain/offers'
import { engineDeps } from '../../../engine/worker'

// No auth: accept (typed full name) or decline while the offer is open.
export default defineEventHandler(async (event) => {
  const { token } = await getValidatedRouterParams(event, z.object({ token: z.string() }).parse)
  const input = await readValidatedBody(event, offerResponse.parse)
  return domain(respondToOffer(engineDeps(useEnv(event), useDb(event)), token, input))
})
