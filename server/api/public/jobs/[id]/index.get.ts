import { z } from 'zod'
import { publicJob } from '../../../../domain/apply'

// No auth: tenant-free public job page. 404 unless published, open and before the closing date.
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(publicJob(useDb(event), id, new Date()))
})
