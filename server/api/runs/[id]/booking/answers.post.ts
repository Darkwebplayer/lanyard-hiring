import { z } from 'zod'
import { answerInput, answerTimes } from '../../../../domain/bookings'
import { deliverLater } from '../../../../domain/emails'
import { mailer } from '../../../../engine/worker'

// A panel member's "I can / I can't" for each offered time. The last answer sends the times on.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, answerInput.parse)
  const env = useEnv(event)
  const db = useDb(event)
  const r = await domain(answerTimes(db, { userId: actor.user.id, level: actor.level }, id, input, new Date(), env.BETTER_AUTH_URL))
  await deliverLater(db, mailer(env), r.applicationId)
  return { sent: r.sent }
})
