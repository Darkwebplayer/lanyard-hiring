import { z } from 'zod'
import { presetPatch, updatePreset } from '../../domain/presets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const patch = await readValidatedBody(event, presetPatch.parse)
  return domain(updatePreset(useDb(event), id, patch))
})
