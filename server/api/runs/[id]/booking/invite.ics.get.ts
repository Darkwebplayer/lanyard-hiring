import { z } from 'zod'
import { bookingIcs, runBooking } from '../../../../domain/bookings'

// The booked interview as a calendar file, for the people on it (the link in their "Interview booked" email).
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const db = useDb(event)
  const b = await domain(runBooking(db, { userId: actor.user.id, level: actor.level }, id))
  const ics = await domain(bookingIcs(db, b.token, new Date(), true))
  setResponseHeaders(event, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="interview.ics"' })
  return ics
})
