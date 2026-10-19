import { z } from 'zod'
import { validateDraft } from '../../../domain/jobs'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return { issues: await domain(validateDraft(useDb(event), id, useEnv(event).ADMIN_EMAIL)) }
})
