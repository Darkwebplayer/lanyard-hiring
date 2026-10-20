import { createFlowPreset, flowPresetInput } from '../../domain/flowPresets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const input = await readValidatedBody(event, flowPresetInput.parse)
  setResponseStatus(event, 201)
  return domain(createFlowPreset(useDb(event), input))
})
