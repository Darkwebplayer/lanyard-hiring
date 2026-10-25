import { z } from 'zod'
import { listDocuments } from '../../../domain/documents'

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return domain(listDocuments(useDb(event), { userId: actor.user.id, level: actor.level }, id))
})
