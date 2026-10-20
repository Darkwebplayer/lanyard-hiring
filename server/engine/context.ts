import { and, desc, eq } from 'drizzle-orm'
import { jobContext } from '../../shared/workflow/job'
import type { Context } from '../../shared/workflow/types'
import type { Db, Tx } from '../db/client'
import { applications, candidates, jobs, jobVersions, nodeRuns } from '../db/schema'

// Assembled on demand, never stored. nodes.<key> is the latest *completed* attempt of that node.
export async function buildContext(db: Db | Tx, applicationId: string): Promise<Context> {
  const [row] = await db.select({ app: applications, candidate: candidates, job: jobs, requirements: jobVersions.requirements })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(jobVersions, eq(jobVersions.id, applications.jobVersionId))
    .where(eq(applications.id, applicationId))
  if (!row) throw new Error(`application ${applicationId} not found`)

  const runs = await db.select({ nodeKey: nodeRuns.nodeKey, output: nodeRuns.output })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.applicationId, applicationId), eq(nodeRuns.status, 'completed')))
    .orderBy(desc(nodeRuns.attempt))
  const nodes: Context['nodes'] = {}
  for (const r of runs) nodes[r.nodeKey] ??= (r.output ?? {}) as Record<string, unknown>

  const c = row.candidate
  return {
    candidate: { first_name: c.firstName, last_name: c.lastName, email: c.email, ...(c.phone && { phone: c.phone }) },
    form: row.app.answers as Record<string, unknown>,
    job: jobContext({ ...row.job, requirements: row.requirements }), // requirements as pinned
    nodes,
  }
}
