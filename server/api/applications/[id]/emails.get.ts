import { z } from 'zod'
import { listEmails } from '../../../domain/emails'

// Every email sent to the candidate, newest first. Same access as the application.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(listEmails(useDb(event), { userId: actor.user.id, level: actor.level }, id))
})
