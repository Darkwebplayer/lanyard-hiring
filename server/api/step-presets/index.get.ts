import { listPresets } from '../../domain/presets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return listPresets(useDb(event))
})
