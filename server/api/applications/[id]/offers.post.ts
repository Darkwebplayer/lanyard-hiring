import { z } from 'zod'
import { makeOffer, offerInput } from '../../../domain/offers'

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, offerInput.parse)
  setResponseStatus(event, 201)
  return domain(makeOffer(useDb(event), id, input, actor.user.id, new Date()))
})
