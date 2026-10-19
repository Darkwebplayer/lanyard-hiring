import { z } from 'zod'
import type { JobContext } from './types'

// Structured requirements on a job, readable in workflows as job.*
export const requirementsSchema = z.object({
  min_experience_years: z.number().min(0).max(60).optional(),
  must_have_skills: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  salary_min: z.number().min(0).optional(),
  salary_max: z.number().min(0).optional(),
  location: z.string().trim().max(200).optional(),
  employment_type: z.string().trim().max(50).optional(),
}).strict().refine(r => r.salary_min === undefined || r.salary_max === undefined || r.salary_min <= r.salary_max, 'salary_min > salary_max')

export type Requirements = z.infer<typeof requirementsSchema>

export const jobContext = (job: { title: string, openings: number, requirements: unknown }): JobContext => ({
  title: job.title,
  openings: job.openings,
  ...(job.requirements as Requirements),
})
