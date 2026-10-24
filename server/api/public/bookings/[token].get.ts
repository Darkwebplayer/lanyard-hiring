import { publicBooking } from '../../../domain/bookings'

// No auth: the candidate's booking page. The token is the only key; unknown or malformed → 404.
export default defineEventHandler(async (event) => {
  return domain(publicBooking(useDb(event), getRouterParam(event, 'token') ?? '', new Date()))
})
