import { availabilityInput, putAvailability } from '../../domain/bookings'

export default defineEventHandler(async (event) => {
  const { user } = await requireUser(event)
  const input = await readValidatedBody(event, availabilityInput.parse)
  return putAvailability(useDb(event), user.id, input)
})
