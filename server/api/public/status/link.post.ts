import { z } from 'zod'
import { deliverLater } from '../../../domain/emails'
import { requestStatusLink } from '../../../domain/status'
import { mailer } from '../../../engine/worker'

const body = z.object({ email: z.email().max(254) })

// No auth: "email me my link". Always 202 with nothing in it, and the send runs after the response, so neither the
// answer nor its timing tells whether the address applied.
export default defineEventHandler(async (event) => {
  const { email } = await readValidatedBody(event, body.parse)
  const env = useEnv(event)
  const db = useDb(event)
  const applicationId = await requestStatusLink(db, email, new Date(), env.BETTER_AUTH_URL)
  if (applicationId) event.waitUntil(deliverLater(db, mailer(env), applicationId) ?? Promise.resolve())
  setResponseStatus(event, 202)
  return { ok: true }
})
