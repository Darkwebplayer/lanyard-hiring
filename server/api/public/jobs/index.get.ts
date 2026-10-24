import { openJobs } from '../../../domain/apply'

// No auth: the careers page. Open, published jobs before their closing date, plus the company's name and intro.
export default defineEventHandler(async (event) => {
  const { company, jobs } = await openJobs(useDb(event), new Date())
  return { company, jobs: jobs.map(({ description: _, ...j }) => j) } // the list only; the full post is on /apply/:id
})
