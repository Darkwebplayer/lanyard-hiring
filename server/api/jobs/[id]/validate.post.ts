import { z } from 'zod'
import { draftWarnings, validateDraft } from '../../../domain/jobs'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const issues = await domain(validateDraft(useDb(event), id, useEnv(event).ADMIN_EMAIL))
  // warnings never block publish; shown in the publish confirmation
  return { issues, warnings: issues.length ? [] : await draftWarnings(useDb(event), id) }
})
