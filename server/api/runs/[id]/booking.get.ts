import { z } from 'zod'
import { runBooking } from '../../../domain/bookings'

// The candidate's booking link for a task, for Copy link. 404 when the task has no booking.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const b = await domain(runBooking(useDb(event), { userId: actor.user.id, level: actor.level }, id))
  return { token: b.token, url: `${useEnv(event).BETTER_AUTH_URL}/book/${b.token}`, durationMin: b.durationMin, startsAt: b.startsAt }
})
