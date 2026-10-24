import { bookingIcs } from '../../../../domain/bookings'

// No auth: the booked interview as a calendar file. 404 until a time is picked.
export default defineEventHandler(async (event) => {
  const ics = await domain(bookingIcs(useDb(event), getRouterParam(event, 'token') ?? '', new Date()))
  setResponseHeaders(event, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="interview.ics"' })
  return ics
})
