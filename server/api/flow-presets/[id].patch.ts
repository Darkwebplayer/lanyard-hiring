import { z } from 'zod'
import { flowPresetPatch, updateFlowPreset } from '../../domain/flowPresets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const patch = await readValidatedBody(event, flowPresetPatch.parse)
  return domain(updateFlowPreset(useDb(event), id, patch))
})
