import { getAvailability } from '../../domain/bookings'

export default defineEventHandler(async (event) => {
  const { user } = await requireUser(event)
  return getAvailability(useDb(event), user.id)
})
