import { z } from 'zod'
import { deletePreset } from '../../domain/presets'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(deletePreset(useDb(event), id))
})
