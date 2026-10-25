import { z } from 'zod'
import { deliverLater } from '../../../domain/emails'
import { makeOffer, offerInput } from '../../../domain/offers'
import { mailer } from '../../../engine/worker'

// Makes the offer and emails the candidate the letter link.
export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, offerInput.parse)
  const env = useEnv(event)
  const offer = await domain(makeOffer(useDb(event), id, input, actor.user.id, new Date(), env.BETTER_AUTH_URL))
  await deliverLater(useDb(event), mailer(env), id)
  setResponseStatus(event, 201)
  return offer
})
