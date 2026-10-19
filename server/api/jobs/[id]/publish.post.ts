import { z } from 'zod'
import { publish } from '../../../domain/jobs'

// 422 with data.issues when the draft is not publishable
export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(publish(useDb(event), id, useEnv(event).ADMIN_EMAIL))
})
