import { hireReport } from '../../domain/applications'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return hireReport(useDb(event))
})
