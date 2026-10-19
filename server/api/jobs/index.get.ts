import { desc, eq, sql } from 'drizzle-orm'
import { jobs, jobVersions, user } from '../../db/schema'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return useDb(event).select({
    id: jobs.id, title: jobs.title, status: jobs.status, openings: jobs.openings, closesAt: jobs.closesAt,
    ownerId: jobs.ownerId, ownerName: user.name, createdAt: jobs.createdAt,
    publishedVersion: jobVersions.version,
    hasDraft: sql<boolean>`exists (select 1 from ${jobVersions} d where d.job_id = ${jobs.id} and d.status = 'draft')`,
  }).from(jobs)
    .innerJoin(user, eq(user.id, jobs.ownerId))
    .leftJoin(jobVersions, eq(jobVersions.id, jobs.publishedVersionId))
    .orderBy(desc(jobs.createdAt))
})
