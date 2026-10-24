import { z } from 'zod'
import { withdrawOffer } from '../../../domain/offers'

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(withdrawOffer(useDb(event), id, actor.user.id))
})
