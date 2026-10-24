import { z } from 'zod'
import { deleteTemplate } from '../../domain/offers'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(deleteTemplate(useDb(event), id))
})
