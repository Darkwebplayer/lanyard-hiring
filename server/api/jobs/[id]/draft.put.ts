import { z } from 'zod'
import { draftShape, saveDraft } from '../../../domain/jobs'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, draftShape.parse)
  return domain(saveDraft(useDb(event), id, input))
})
