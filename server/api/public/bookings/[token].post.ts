import { z } from 'zod'
import { book } from '../../../domain/bookings'
import { deliverLater } from '../../../domain/emails'
import { mailer } from '../../../engine/worker'

const body = z.object({ startsAt: z.iso.datetime({ offset: true }), timezone: z.string().max(100).optional() })

// No auth: the candidate picks (or changes) the interview time. `timezone` is theirs, for the confirmation email.
export default defineEventHandler(async (event) => {
  const { startsAt, timezone } = await readValidatedBody(event, body.parse)
  const env = useEnv(event)
  const db = useDb(event)
  const r = await domain(book(db, getRouterParam(event, 'token') ?? '', new Date(startsAt), new Date(), timezone, env.BETTER_AUTH_URL))
  await deliverLater(db, mailer(env), r.applicationId)
  return { startsAt: r.startsAt }
})
