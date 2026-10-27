import { z } from 'zod'
import { book } from '../../../domain/bookings'
import { deliverLater } from '../../../domain/emails'
import { mailer } from '../../../engine/worker'

const body = z.object({ startsAt: z.iso.datetime({ offset: true }), timezone: z.string().max(100).optional() })

// No auth: the candidate picks (or changes) the interview time. `timezone` is theirs, for the confirmation email.
// The people on it get their own email with a calendar file after commit.
export default defineEventHandler(async (event) => {
  const { startsAt, timezone } = await readValidatedBody(event, body.parse)
  const env = useEnv(event)
  const db = useDb(event)
  const r = await domain(book(db, getRouterParam(event, 'token') ?? '', new Date(startsAt), new Date(), timezone, env.BETTER_AUTH_URL))
  await deliverLater(db, mailer(env), r.applicationId)
  const send = mailer(env)
  await Promise.all(r.team.map(t => send(t.key, t.email).catch(e => console.error('[email] team invite failed', t.key, e))))
  return { startsAt: r.startsAt }
})
