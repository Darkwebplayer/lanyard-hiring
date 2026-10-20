import { z } from 'zod'
import { pipeline } from '../../../domain/applications'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(pipeline(useDb(event), id))
})
