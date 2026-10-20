import { z } from 'zod'
import { deleteFlowPreset } from '../../domain/flowPresets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(deleteFlowPreset(useDb(event), id))
})
