import { z } from 'zod'
import { templatePatch, updateTemplate } from '../../domain/offers'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const patch = await readValidatedBody(event, templatePatch.parse)
  return domain(updateTemplate(useDb(event), id, patch))
})
