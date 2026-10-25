import { z } from 'zod'
import { documentsReminder } from '../../../domain/documents'
import { deliver } from '../../../domain/emails'
import { EmailError } from '../../../engine/email'
import { mailer } from '../../../engine/worker'

// "Send a reminder": emails the candidate the link again, listing what's still missing. Logged like every candidate email.
// Once a day: a second ask the same day sends nothing and says so.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const env = useEnv(event)
  const db = useDb(event)
  const r = await domain(documentsReminder(db, { userId: actor.user.id, level: actor.level }, id, env.BETTER_AUTH_URL, new Date()))
  if (!r.queued) return { sent: false, reason: 'already_today' as const }
  await deliver(db, mailer(env), { key: r.key }).catch((e) => {
    if (e instanceof EmailError) throw createError({ statusCode: 502, message: 'email_failed' })
    throw e
  })
  return { sent: true }
})
