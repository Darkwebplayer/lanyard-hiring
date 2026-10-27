import { askOtherTimes, noteInput } from '../../../../domain/bookings'

// No auth: "None of these work", with a note for the team.
export default defineEventHandler(async (event) => {
  const { note } = await readValidatedBody(event, noteInput.parse)
  await domain(askOtherTimes(useDb(event), getRouterParam(event, 'token') ?? '', note, new Date()))
  return { ok: true }
})
