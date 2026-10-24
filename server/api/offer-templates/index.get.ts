import { listTemplates } from '../../domain/offers'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return listTemplates(useDb(event))
})
