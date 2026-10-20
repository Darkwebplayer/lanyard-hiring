import { z } from 'zod'
import { reorderSection } from '../../domain/presets'

const body = z.object({ section: z.string(), ids: z.array(z.uuid()).max(200) })

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { section, ids } = await readValidatedBody(event, body.parse)
  return domain(reorderSection(useDb(event), section, ids))
})
