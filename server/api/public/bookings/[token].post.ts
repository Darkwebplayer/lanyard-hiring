import { z } from 'zod'
import { book } from '../../../domain/bookings'

const body = z.object({ startsAt: z.iso.datetime({ offset: true }) })

// No auth: the candidate picks (or changes) the interview time.
export default defineEventHandler(async (event) => {
  const { startsAt } = await readValidatedBody(event, body.parse)
  return domain(book(useDb(event), getRouterParam(event, 'token') ?? '', new Date(startsAt), new Date()))
})
