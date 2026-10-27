import { z } from 'zod'
import { offerInput, offerTimes } from '../../../../domain/bookings'
import { deliverLater } from '../../../../domain/emails'
import { mailer } from '../../../../engine/worker'

// Offer times for the interview (replacing any on the table). Alone on it, they go to the candidate at once;
// on a panel, the others say which they can make first.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, offerInput.parse)
  const env = useEnv(event)
  const db = useDb(event)
  const r = await domain(offerTimes(db, { userId: actor.user.id, level: actor.level }, id, input, new Date(), env.BETTER_AUTH_URL))
  await deliverLater(db, mailer(env), r.applicationId)
  return { sent: r.sent }
})
