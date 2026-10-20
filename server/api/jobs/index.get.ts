import { desc, eq, sql } from 'drizzle-orm'
import { applications, jobs, jobVersions, nodeRuns, user } from '../../db/schema'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  return useDb(event).select({
    id: jobs.id, title: jobs.title, status: jobs.status, openings: jobs.openings, closesAt: jobs.closesAt,
    ownerId: jobs.ownerId, ownerName: user.name, createdAt: jobs.createdAt,
    publishedVersion: jobVersions.version,
    hasDraft: sql<boolean>`exists (select 1 from ${jobVersions} d where d.job_id = ${jobs.id} and d.status = 'draft')`,
    // pipeline at a glance: active candidates, the ones stopped on a failed step, and hires
    active: sql<number>`(select count(*) from ${applications} a where a.job_id = ${jobs.id} and a.status = 'active')`.mapWith(Number),
    stopped: sql<number>`(select count(*) from ${applications} a where a.job_id = ${jobs.id} and a.status = 'active'
      and (select r.status from ${nodeRuns} r where r.application_id = a.id order by r.seq desc limit 1) = 'failed')`.mapWith(Number),
    hired: sql<number>`(select count(*) from ${applications} a where a.job_id = ${jobs.id} and a.outcome = 'hired')`.mapWith(Number),
  }).from(jobs)
    .innerJoin(user, eq(user.id, jobs.ownerId))
    .leftJoin(jobVersions, eq(jobVersions.id, jobs.publishedVersionId))
    .orderBy(desc(jobs.createdAt))
})
