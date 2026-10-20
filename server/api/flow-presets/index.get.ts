import { listFlowPresets } from '../../domain/flowPresets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return listFlowPresets(useDb(event))
})
