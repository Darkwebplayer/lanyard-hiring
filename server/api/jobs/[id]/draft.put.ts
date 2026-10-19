import { z } from 'zod'
import { graphSchema } from '../../../../shared/workflow/graph'
import { saveDraft } from '../../../domain/jobs'

// Lenient on purpose: drafts may be half-built. Publish runs the full validation.
const body = z.object({
  form: z.array(z.looseObject({ key: z.string() })).max(100),
  workflow: graphSchema,
})

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const input = await readValidatedBody(event, body.parse)
  return domain(saveDraft(useDb(event), id, input))
})
