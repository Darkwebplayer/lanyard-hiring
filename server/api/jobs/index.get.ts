import { listJobs } from '../../domain/jobs'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return listJobs(useDb(event))
})
