import { z } from 'zod'
import { getJob } from '../../../domain/jobs'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(getJob(useDb(event), id))
})
