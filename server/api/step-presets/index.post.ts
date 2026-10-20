import { createPreset, presetInput } from '../../domain/presets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const input = await readValidatedBody(event, presetInput.parse)
  setResponseStatus(event, 201)
  return domain(createPreset(useDb(event), input))
})
