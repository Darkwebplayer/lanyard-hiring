import { declineInterview, noteInput } from '../../../../domain/bookings'

// No auth: "I'm no longer interested". The team hears it; nothing closes.
export default defineEventHandler(async (event) => {
  const { note } = await readValidatedBody(event, noteInput.parse)
  await domain(declineInterview(useDb(event), getRouterParam(event, 'token') ?? '', note, new Date()))
  return { ok: true }
})
