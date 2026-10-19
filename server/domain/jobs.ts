import { and, desc, eq, inArray, max, sql } from 'drizzle-orm'
import { formSchemaDef } from '../../shared/workflow/form'
import { checkVersionCompat, fieldsAvailableAt, validateVersion } from '../../shared/workflow/graph'
import type { HumanTaskConfig } from '../../shared/workflow/registry'
import { REGISTRY } from '../../shared/workflow/registry'
import { STANDARD_HIRE } from '../../shared/workflow/templates'
import type { FormField, Graph, Issue } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { jobs, jobVersions, roles, user } from '../db/schema'
import { accessLevel } from './access'
import { DomainError } from './errors'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Version = typeof jobVersions.$inferSelect

const BLANK: { form: FormField[], workflow: Graph } = {
  form: [],
  workflow: { nodes: [{ key: 'start', type: 'application_received', config: {}, position: { x: 0, y: 0 } }], edges: [] },
}

export type StartFrom = { kind: 'blank' } | { kind: 'standard_hire' } | { kind: 'job', jobId: string }

export async function createJob(
  db: Db,
  ownerId: string,
  input: Pick<typeof jobs.$inferInsert, 'title' | 'description' | 'requirements' | 'openings' | 'closesAt'>,
  from: StartFrom,
) {
  // "duplicate to job" copies the JSON; publish validation then flags anything that doesn't fit
  const start = from.kind === 'blank'
    ? BLANK
    : from.kind === 'standard_hire'
      ? STANDARD_HIRE
      : await latestVersion(db, from.jobId).then((v) => {
          if (!v) throw new DomainError(404, 'source_job_not_found')
          return { form: v.form as FormField[], workflow: v.workflow as Graph }
        })
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values({ ...input, ownerId }).returning()
    const [draft] = await tx.insert(jobVersions).values({
      jobId: job!.id, version: 1, form: structuredClone(start.form), workflow: structuredClone(start.workflow),
    }).returning()
    return { job: job!, draft: draft! }
  })
}

// The draft if there is one, else the published version.
async function latestVersion(db: Db | Tx, jobId: string) {
  const [v] = await db.select().from(jobVersions).where(eq(jobVersions.jobId, jobId))
    .orderBy(desc(jobVersions.version)).limit(1)
  return v
}

async function lockJob(tx: Tx, jobId: string) {
  // serialises draft saves and publishes per job
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update')
  if (!job) throw new DomainError(404, 'job_not_found')
  return job
}

export async function getJob(db: Db, jobId: string) {
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) })
  if (!job) throw new DomainError(404, 'job_not_found')
  const versions = await db.select().from(jobVersions)
    .where(and(eq(jobVersions.jobId, jobId), sql`(${jobVersions.status} = 'draft' or ${jobVersions.id} = ${job.publishedVersionId})`))
  return {
    job,
    draft: versions.find(v => v.status === 'draft') ?? null,
    published: versions.find(v => v.id === job.publishedVersionId) ?? null,
  }
}

// Drafts may be invalid; only the shape is checked (by the route). Editing a published job opens draft N+1.
export async function saveDraft(db: Db, jobId: string, body: { form: unknown[], workflow: Graph }) {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId)
    if (job.status === 'archived') throw new DomainError(409, 'job_archived')
    const [updated] = await tx.update(jobVersions).set({ form: body.form, workflow: body.workflow })
      .where(and(eq(jobVersions.jobId, jobId), eq(jobVersions.status, 'draft'))).returning()
    if (updated) return updated
    const [{ n }] = await tx.select({ n: max(jobVersions.version) }).from(jobVersions).where(eq(jobVersions.jobId, jobId)) as [{ n: number | null }]
    const [created] = await tx.insert(jobVersions).values({ jobId, version: (n ?? 0) + 1, form: body.form, workflow: body.workflow }).returning()
    return created!
  })
}

// Everything that blocks publish: pure validation, key compatibility, and assignees that must exist now.
export async function versionIssues(db: Db | Tx, job: typeof jobs.$inferSelect, draft: Version, adminEmail: string): Promise<Issue[]> {
  const issues = validateVersion(draft.form, draft.workflow)
  if (issues.length) return issues // later checks assume a well-formed version

  const form = draft.form as FormField[]
  const workflow = draft.workflow as Graph
  if (job.publishedVersionId) {
    const prev = await db.query.jobVersions.findFirst({ where: eq(jobVersions.id, job.publishedVersionId) })
    issues.push(...checkVersionCompat({ form: prev!.form as FormField[], workflow: prev!.workflow as Graph }, { form, workflow }))
  }
  issues.push(...await assigneeIssues(db, workflow, job.ownerId, adminEmail))
  return issues
}

// Assignees are resolved again when a task activates; this catches what is already wrong at publish.
async function assigneeIssues(db: Db | Tx, workflow: Graph, ownerId: string, adminEmail: string): Promise<Issue[]> {
  const tasks = workflow.nodes
    .filter(n => n.type === 'human_task')
    .map(n => ({ key: n.key, config: REGISTRY.human_task!.config.parse(n.config) as HumanTaskConfig }))
  if (!tasks.length) return []

  const userIds = [...new Set([ownerId, ...tasks.flatMap(t => t.config.assignees.users)])]
  const roleIds = [...new Set(tasks.flatMap(t => t.config.assignees.roles))]
  const [users, knownRoles, roleMembers] = await Promise.all([
    db.select({ id: user.id, email: user.email, active: user.active, level: roles.level })
      .from(user).leftJoin(roles, eq(roles.id, user.roleId)).where(inArray(user.id, userIds)),
    roleIds.length ? db.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds)) : [],
    roleIds.length
      ? db.select({ id: user.id, roleId: user.roleId }).from(user).where(and(inArray(user.roleId, roleIds), eq(user.active, true)))
      : [],
  ])
  const usable = new Set(users.filter(u => accessLevel(u, u.level, adminEmail)).map(u => u.id))
  const roleSet = new Set(knownRoles.map(r => r.id))

  const issues: Issue[] = []
  for (const { key, config } of tasks) {
    const a = config.assignees
    for (const id of a.users) if (!usable.has(id)) issues.push({ node: key, code: 'bad_assignee', message: `assignee ${id} does not exist or has no access` })
    for (const id of a.roles) if (!roleSet.has(id)) issues.push({ node: key, code: 'bad_role', message: `role ${id} does not exist` })
    const pool = new Set([
      ...a.users.filter(id => usable.has(id)),
      ...(a.job_owner && usable.has(ownerId) ? [ownerId] : []),
      ...roleMembers.filter(m => a.roles.includes(m.roleId!)).map(m => m.id),
    ])
    if (pool.size < config.min_submissions) {
      issues.push({ node: key, code: 'not_enough_assignees', message: `needs ${config.min_submissions} submissions but only ${pool.size} people can be assigned` })
    }
  }
  return issues
}

export async function validateDraft(db: Db, jobId: string, adminEmail: string) {
  const { job, draft } = await getJob(db, jobId)
  if (!draft) throw new DomainError(409, 'no_draft')
  return versionIssues(db, job, draft, adminEmail)
}

// Freezes the draft. In-flight applications stay pinned to the version they started on.
export async function publish(db: Db, jobId: string, adminEmail: string) {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId)
    if (job.status === 'archived') throw new DomainError(409, 'job_archived')
    const [draft] = await tx.select().from(jobVersions).where(and(eq(jobVersions.jobId, jobId), eq(jobVersions.status, 'draft')))
    if (!draft) throw new DomainError(409, 'no_draft')
    const issues = await versionIssues(tx, job, draft, adminEmail)
    if (issues.length) throw new DomainError(422, 'invalid_version', issues)
    const [published] = await tx.update(jobVersions).set({ status: 'published', publishedAt: new Date() })
      .where(eq(jobVersions.id, draft.id)).returning()
    await tx.update(jobs).set({ publishedVersionId: draft.id, status: job.status === 'draft' ? 'open' : job.status })
      .where(eq(jobs.id, jobId))
    return published!
  })
}

// Variable picker: works on the draft (or the published version when there is no draft).
export async function pickerFields(db: Db, jobId: string, nodeKey: string) {
  const { draft, published } = await getJob(db, jobId)
  const v = draft ?? published
  if (!v) throw new DomainError(404, 'no_version')
  const workflow = v.workflow as Graph
  if (!workflow.nodes.some(n => n.key === nodeKey)) throw new DomainError(404, 'node_not_found')
  const form = formSchemaDef.safeParse(v.form) // drafts may hold a half-edited form
  return fieldsAvailableAt(workflow, nodeKey, form.success ? form.data : [])
}
