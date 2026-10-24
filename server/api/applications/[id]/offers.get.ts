import { z } from 'zod'
import { listOffers } from '../../../domain/offers'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return listOffers(useDb(event), id)
})
