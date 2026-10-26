import { type AnyColumn, type SQL, and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import type { FormField, Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applicationEvents, applications, candidates, jobs, jobVersions, nodeRuns, offers, taskAssignments, user } from '../db/schema'
import { atLeastManager, type Level } from './access'
import { documentsStatus } from './documents'
import { DomainError } from './errors'

export interface Viewer { userId: string, level: Level }

// An assignment grants access while it is open, or for good once its holder submitted.
// Removed (or moved-away) assignees who never submitted lose access.
export const holdsAssignment = or(isNull(taskAssignments.closedAt), isNotNull(taskAssignments.submittedAt))

// Still on the task when it ended (or now): not passed, let go or taken off before then. Needs node_runs joined.
// Whose calendar a booked interview belongs to.
export const heldThrough = or(holdsAssignment, and(eq(nodeRuns.status, 'completed'), gte(taskAssignments.closedAt, nodeRuns.completedAt)))

// Managers see every application; others only those they hold a task on. Anything else is 404 so ids don't leak.
export async function assertCanSee(db: Db, viewer: Viewer, applicationId: string) {
  if (atLeastManager(viewer.level)) return
  const [row] = await db.select({ runId: taskAssignments.runId }).from(taskAssignments)
    .innerJoin(nodeRuns, eq(nodeRuns.id, taskAssignments.runId))
    .where(and(eq(nodeRuns.applicationId, applicationId), eq(taskAssignments.userId, viewer.userId), holdsAssignment))
    .limit(1)
  if (!row) throw new DomainError(404, 'application_not_found')
}

interface AssignmentView { userId: string, values: unknown }

// Nodes the viewer still has to score on this application. Blind panels: for these, every attempt's
// scorecards but the viewer's own are hidden (an earlier attempt's scores would bias the new one).
export async function blindNodes(db: Db, viewer: Viewer, applicationId: string) {
  if (atLeastManager(viewer.level)) return new Set<string>()
  const rows = await db.select({ nodeKey: nodeRuns.nodeKey }).from(taskAssignments)
    .innerJoin(nodeRuns, eq(nodeRuns.id, taskAssignments.runId))
    .where(and(eq(nodeRuns.applicationId, applicationId), eq(nodeRuns.status, 'waiting_on_human'), eq(taskAssignments.userId, viewer.userId),
      isNull(taskAssignments.closedAt), isNull(taskAssignments.submittedAt)))
  return new Set(rows.map(r => r.nodeKey))
}

export function visibleAssignments<T extends AssignmentView>(nodeKey: string, assignments: T[], viewer: Viewer, blind: Set<string>): T[] {
  if (!blind.has(nodeKey)) return assignments
  return assignments.map(a => a.userId === viewer.userId ? a : { ...a, values: null })
}

// Protected answers (e.g. date of birth) are for managers only.
export const hiddenFields = (form: FormField[], viewer: Viewer) =>
  new Set(atLeastManager(viewer.level) ? [] : form.filter(f => f.protected).map(f => f.key))

export async function loadApplication(db: Db, applicationId: string) {
  const [row] = await db.select({
    app: applications, candidate: candidates, job: { id: jobs.id, title: jobs.title },
    version: { version: jobVersions.version, form: jobVersions.form, workflow: jobVersions.workflow },
  }).from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(jobVersions, eq(jobVersions.id, applications.jobVersionId))
    .where(eq(applications.id, applicationId))
  if (!row) throw new DomainError(404, 'application_not_found')
  return row
}

// Everything that happened, in order: runs (with the condition evaluations that explain each
// decision), scorecards, and the event log.
export async function timeline(db: Db, viewer: Viewer, applicationId: string, now: Date) {
  await assertCanSee(db, viewer, applicationId)
  const { app, candidate, job, version } = await loadApplication(db, applicationId)
  const form = version.form as FormField[]
  const hidden = hiddenFields(form, viewer)

  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.applicationId, app.id)).orderBy(asc(nodeRuns.seq))
  const assignments = runs.length
    ? await db.select({
        runId: taskAssignments.runId, userId: taskAssignments.userId, name: user.name, assignedAt: taskAssignments.assignedAt,
        submittedAt: taskAssignments.submittedAt, closedAt: taskAssignments.closedAt, values: taskAssignments.values,
      }).from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId))
        .where(inArray(taskAssignments.runId, runs.map(r => r.id))).orderBy(asc(taskAssignments.assignedAt), asc(taskAssignments.userId))
    : []
  const events = await db.select({
    id: applicationEvents.id, type: applicationEvents.type, data: applicationEvents.data, createdAt: applicationEvents.createdAt,
    actorId: applicationEvents.actorId, actorName: user.name,
  }).from(applicationEvents).leftJoin(user, eq(user.id, applicationEvents.actorId))
    .where(eq(applicationEvents.applicationId, app.id)).orderBy(asc(applicationEvents.seq))

  const blind = await blindNodes(db, viewer, app.id)
  // Run data can carry protected answers (condition traces, copies, CV text of a protected file),
  // so only managers get it; others see the path, statuses and scorecards.
  const manager = atLeastManager(viewer.level)
  return {
    application: {
      id: app.id, status: app.status, outcome: app.outcome, currentNodeKey: app.currentNodeKey, createdAt: app.createdAt,
      source: app.source, consent: app.consent,
      answers: Object.fromEntries(Object.entries(app.answers as Record<string, unknown>).filter(([k]) => !hidden.has(k))),
    },
    candidate: { firstName: candidate.firstName, lastName: candidate.lastName, email: candidate.email, phone: candidate.phone },
    job,
    version: version.version,
    form: form.filter(f => !hidden.has(f.key)).map(({ key, label, type }) => ({ key, label, type })),
    nodes: (version.workflow as Graph).nodes.map(({ key, type, label }) => ({ key, type, label })),
    // the pinned flow, for next moves and the flow panel (configs can name people and rules: managers only)
    ...(manager && { graph: version.workflow as Graph }),
    runs: runs.map(r => ({
      id: r.id, nodeKey: r.nodeKey, nodeType: r.nodeType, attempt: r.attempt, status: r.status,
      ...(manager && { input: r.input, output: r.output, evaluation: r.evaluation }),
      branchTaken: r.branchTaken, error: r.error, retries: r.retries,
      dueAt: r.dueAt, overdue: isOverdue(r, now), actorId: r.actorId, createdAt: r.createdAt, completedAt: r.completedAt,
      assignments: visibleAssignments(r.nodeKey, assignments.filter(a => a.runId === r.id), viewer, blind).map(({ runId: _, ...a }) => a),
    })),
    events,
    // the latest AI review's scores and summary, for everyone who can see the application: the AI never reads protected answers
    aiReview: (runs.findLast(r => r.nodeType === 'ai_review' && r.status === 'completed')?.output ?? null) as Record<string, unknown> | null,
  }
}

export const isOverdue = (r: { status: string, dueAt: Date | null }, now: Date) =>
  r.status === 'waiting_on_human' && !!r.dueAt && r.dueAt < now

// One file answer, for streaming from R2.
export async function fileAnswer(db: Db, viewer: Viewer, applicationId: string, field: string) {
  await assertCanSee(db, viewer, applicationId)
  const { app, version } = await loadApplication(db, applicationId)
  const def = (version.form as FormField[]).find(f => f.key === field && f.type === 'file')
  const meta = (app.answers as Record<string, { key: string, mime: string, name: string } | undefined>)[field]
  if (!def || hiddenFields([def], viewer).size || !meta) throw new DomainError(404, 'file_not_found')
  return meta
}

export type PipelineShow = 'active' | 'hired' | 'rejected' | 'withdrawn' | 'all'
export interface PipelineQuery {
  show?: PipelineShow, q?: string, step?: string, limit?: number, offset?: number
  minScore?: number, maxScore?: number, source?: string // source 'none' = unknown (null)
}

async function assertJob(db: Db, jobId: string) {
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId))
  if (!job) throw new DomainError(404, 'job_not_found')
}

// Who comes first in a list: stopped (nothing happens until someone acts), then late tasks, then newest.
// `id` is passed in because a single-table select leaves columns unqualified, which a subquery would bind to node_runs.
const latestRun = (id: SQL | AnyColumn) => sql`(select r.id from ${nodeRuns} r where r.application_id = ${id} order by r.seq desc limit 1)`
const urgency = (id: SQL | AnyColumn) => sql`case when ${applications.status} <> 'active' then 0
  when (select r.status from ${nodeRuns} r where r.id = ${latestRun(id)}) = 'failed' then 2
  when (select r.status = 'waiting_on_human' and r.due_at < now() from ${nodeRuns} r where r.id = ${latestRun(id)}) then 1 else 0 end`

// Overall of the latest completed AI review, null if none.
const score = (id: SQL | AnyColumn) => sql<number | null>`(select (r.output->>'overall')::float8 from ${nodeRuns} r
  where r.application_id = ${id} and r.node_type = 'ai_review' and r.status = 'completed' order by r.seq desc limit 1)`
// When they arrived where they are: the latest run of the current step, or the close.
const since = sql<string>`coalesce(case when ${applications.status} = 'active'
  then (select r.created_at from ${nodeRuns} r where r.application_id = ${applications.id} and r.node_key = ${applications.currentNodeKey} order by r.seq desc limit 1)
  else (select e.created_at from ${applicationEvents} e where e.application_id = ${applications.id} and e.type = 'closed' order by e.seq desc limit 1) end,
  ${applications.createdAt})`

function rows(db: Db, where: SQL | undefined) {
  const latest = latestRun(applications.id)
  return db.select({
    id: applications.id, status: applications.status, outcome: applications.outcome, currentNodeKey: applications.currentNodeKey,
    createdAt: applications.createdAt, version: jobVersions.version, source: applications.source,
    score: score(applications.id), since,
    candidate: { firstName: candidates.firstName, lastName: candidates.lastName, email: candidates.email },
    runStatus: sql<string | null>`(select r.status from ${nodeRuns} r where r.id = ${latest})`,
    // who holds the candidate now, and by when: the open assignments of the latest run (empty unless it's a task)
    dueAt: sql<string | null>`(select r.due_at from ${nodeRuns} r where r.id = ${latest})`,
    assignees: sql<{ id: string, name: string, submitted: boolean }[]>`coalesce((
      select json_agg(json_build_object('id', u.id, 'name', u.name, 'submitted', ta.submitted_at is not null) order by u.name)
      from ${taskAssignments} ta join ${user} u on u.id = ta.user_id
      where ta.closed_at is null and ta.run_id = ${latest}
    ), '[]'::json)`,
    // how many match, before the page is cut
    total: sql<number>`count(*) over ()`.mapWith(Number),
  }).from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobVersions, eq(jobVersions.id, applications.jobVersionId))
    .where(where)
    .orderBy(desc(urgency(applications.id)), desc(applications.createdAt), desc(applications.id))
}

// Pipeline list for a job: one page of applications with where they are and the state of their latest run.
// `step` may name several steps, comma separated (a whole stage).
export async function pipeline(db: Db, jobId: string, query: PipelineQuery = {}) {
  await assertJob(db, jobId)
  const { show = 'all', q, step, limit = 50, offset = 0, minScore, maxScore, source } = query
  const needle = q?.trim() && `%${q.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`
  return rows(db, and(
    eq(applications.jobId, jobId),
    show === 'all' ? undefined : show === 'active' ? eq(applications.status, 'active') : eq(applications.outcome, show),
    step ? inArray(applications.currentNodeKey, step.split(',')) : undefined,
    minScore !== undefined ? sql`${score(applications.id)} >= ${minScore}` : undefined,
    maxScore !== undefined ? sql`${score(applications.id)} <= ${maxScore}` : undefined,
    source === 'none' ? isNull(applications.source) : source ? eq(applications.source, source) : undefined,
    needle
      ? or(ilike(sql`${candidates.firstName} || ' ' || ${candidates.lastName}`, needle), ilike(candidates.email, needle))
      : undefined,
  )).limit(limit).offset(offset)
}

// Board for a job: how many applications sit at each step (or outcome), plus only the first few rows of each,
// so it stays cheap at thousands of applicants.
const PREVIEW = 30
export async function board(db: Db, jobId: string, now = new Date()) {
  await assertJob(db, jobId)
  // single-table select: drizzle leaves columns unqualified, which inside a subquery would bind to node_runs
  const appId = sql`${applications}."id"`
  // closed people group by outcome alone: a hire from an accepted offer still sits on the interview step's key
  const at = sql<string | null>`case when ${applications.status} = 'active' then ${applications.currentNodeKey} end`
  const counts = await db.select({
    key: at, status: applications.status, outcome: applications.outcome, n: count(),
    failed: sql<number>`count(*) filter (where (select r.status from ${nodeRuns} r where r.application_id = ${appId} order by r.seq desc limit 1) = 'failed')`.mapWith(Number),
    // a waiting task is the active run, and there is at most one of those
    overdue: sql<number>`count(*) filter (where exists (select 1 from ${nodeRuns} r where r.application_id = ${appId} and r.status = 'waiting_on_human' and r.due_at < ${now.toISOString()}::timestamptz))`.mapWith(Number),
  }).from(applications).where(eq(applications.jobId, jobId))
    .groupBy(at, applications.status, applications.outcome)
  // newest first: labels and stages come from the latest version; older versions only name steps that are gone
  const versions = await db.select({ status: jobVersions.status, workflow: jobVersions.workflow }).from(jobVersions)
    .where(eq(jobVersions.jobId, jobId)).orderBy(desc(jobVersions.version))
  const graphs = versions.map(v => v.workflow as Graph)
  const live = (versions.find(v => v.status === 'published') ?? versions[0])?.workflow as Graph | undefined
  // A step gets a row if the live flow has it or someone is standing on it (applicants on older versions).
  const keys = new Set([...(live?.nodes ?? []).map(n => n.key), ...counts.map(c => c.status === 'active' ? c.key : null)])
  const steps = [...keys].flatMap((key) => {
    const node = key && graphs.map(g => g.nodes.find(n => n.key === key)).find(Boolean)
    return node ? [{ key: node.key, type: node.type, label: node.label }] : []
  })
  // the first few people of each group, in list order, so cards show faces and lists open with someone in them
  const ranked = db.select({
    id: applications.id,
    rn: sql<number>`row_number() over (partition by ${at}, ${applications.status}, ${applications.outcome}
      order by ${urgency(appId)} desc, ${applications.createdAt} desc, ${applications.id} desc)`.as('rn'),
  }).from(applications).where(eq(applications.jobId, jobId)).as('ranked')
  const top = await db.select({ id: ranked.id }).from(ranked).where(lte(ranked.rn, PREVIEW))
  const preview = top.length ? await rows(db, inArray(applications.id, top.map(r => r.id))) : []
  return { stages: live?.stages ?? null, steps, counts, preview } // published stages: a draft's edits stay off the live board
}

export type MoveFrom = { node: string } | { closed: 'hired' | 'rejected' | 'withdrawn' }

// Who a board drop would move: everyone at `from` (or just `ids`), minus those whose pinned flow
// doesn't have the target step (moveApplication would refuse them).
export async function movable(db: Db, jobId: string, from: MoveFrom, target: { node: string } | { close: string }, ids?: string[], except?: string[]) {
  const rows = await db.select({ id: applications.id, versionId: applications.jobVersionId, workflow: jobVersions.workflow }).from(applications)
    .innerJoin(jobVersions, eq(jobVersions.id, applications.jobVersionId))
    .where(and(
      eq(applications.jobId, jobId),
      'node' in from
        ? and(eq(applications.status, 'active'), eq(applications.currentNodeKey, from.node))
        : and(eq(applications.status, 'closed'), eq(applications.outcome, from.closed)),
      ids ? inArray(applications.id, ids) : undefined,
      except?.length ? notInArray(applications.id, except) : undefined,
    ))
  const fits = (g: Graph) => !('node' in target) || g.nodes.some(n => n.key === target.node)
  const ok = rows.filter(r => fits(r.workflow as Graph))
  // the distinct pinned flows of those who would move, so a move can be checked against each before anything is sent
  const graphs = [...new Map(ok.map(r => [r.versionId, r.workflow as Graph])).values()]
  return { ids: ok.map(r => r.id), notInVersion: rows.length - ok.length, graphs }
}

// Hires against openings, for every job that was ever published.
// Who was hired in the last 90 days, newest first: when, how (the accepted offer's answer, else a move by hand,
// else the flow), and the start date from the accepted offer's terms.
async function recentHires(db: Db) {
  const closed = (col: SQL) => sql`(select ${col} from ${applicationEvents} e where e.application_id = ${applications.id} and e.type = 'closed' order by e.seq desc limit 1)`
  const hiredAt = closed(sql`e.created_at`)
  const offer = (col: SQL) => sql`(select ${col} from ${offers} o where o.application_id = ${applications.id} and o.status = 'accepted' order by o.responded_at desc nulls last limit 1)`
  const rows = await db.select({
    id: applications.id, firstName: candidates.firstName, lastName: candidates.lastName, jobId: jobs.id, jobTitle: jobs.title,
    hiredAt: sql<string>`${hiredAt}`,
    manual: sql<boolean | null>`${closed(sql`(e.data->>'manual')::boolean`)}`,
    via: sql<string | null>`${offer(sql`o.answer->>'via'`)}`,
    startDate: sql<string | null>`${offer(sql`o.terms->>'start_date'`)}`,
  }).from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.outcome, 'hired'), sql`${hiredAt} > now() - interval '90 days'`))
    .orderBy(sql`${hiredAt} desc`)
  return rows.map(({ manual, via, ...r }) => ({ ...r, how: (via ?? (manual ? 'hand' : 'flow')) as 'link' | 'phone' | 'email' | 'in_person' | 'hand' | 'flow' }))
}

export async function hireReport(db: Db) {
  const rows = await db.select({
    id: jobs.id, title: jobs.title, status: jobs.status, openings: jobs.openings,
    applications: count(applications.id),
    hired: sql<number>`count(${applications.id}) filter (where ${applications.outcome} = 'hired')`.mapWith(Number),
  }).from(jobs).leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(isNotNull(jobs.publishedVersionId))
    .groupBy(jobs.id).orderBy(desc(jobs.createdAt))
  const openings = rows.reduce((n, r) => n + r.openings, 0)
  const hires = rows.reduce((n, r) => n + r.hired, 0)
  // where applicants came from, across jobs; null = unknown (applied before sources were tracked, or no ?src)
  const bySource = await db.select({
    source: applications.source,
    applied: count(),
    hired: sql<number>`count(*) filter (where ${applications.outcome} = 'hired')`.mapWith(Number),
  }).from(applications).groupBy(applications.source).orderBy(desc(count()), asc(applications.source))
  const recent = await recentHires(db)
  const docs = await documentsStatus(db, recent.map(h => h.id))
  return {
    jobs: rows.map(r => ({ ...r, fillRate: r.hired / r.openings })),
    totals: { jobs: rows.length, openings, hires, fillRate: openings ? hires / openings : 0 },
    bySource,
    hired: recent.map(h => ({ ...h, documents: docs[h.id] ?? null })),
  }
}
