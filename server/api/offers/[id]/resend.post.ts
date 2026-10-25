import { z } from 'zod'
import { deliverLater } from '../../../domain/emails'
import { resendOffer } from '../../../domain/offers'
import { mailer } from '../../../engine/worker'

// Send again: emails the open offer's link once more.
export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const env = useEnv(event)
  const { applicationId } = await domain(resendOffer(useDb(event), id, new Date(), env.BETTER_AUTH_URL))
  await deliverLater(useDb(event), mailer(env), applicationId)
  return { ok: true }
})
