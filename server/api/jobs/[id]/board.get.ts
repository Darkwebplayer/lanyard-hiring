import { z } from 'zod'
import { board } from '../../../domain/applications'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(board(useDb(event), id))
})
