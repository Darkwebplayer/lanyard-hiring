import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { FormField, Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applicationEvents, applications, candidates, jobs, jobVersions, nodeRuns, taskAssignments, user } from '../db/schema'
import { atLeastManager, type Level } from './access'
import { DomainError } from './errors'

export interface Viewer { userId: string, level: Level }

// An assignment grants access while it is open, or for good once its holder submitted.
// Removed (or moved-away) assignees who never submitted lose access.
export const holdsAssignment = or(isNull(taskAssignments.closedAt), isNotNull(taskAssignments.submittedAt))

// Managers see every application; others only those they hold a task on. Anything else is 404 so ids don't leak.
export async function assertCanSee(db: Db, viewer: Viewer, applicationId: string) {
  if (atLeastManager(viewer.level)) return
  const [row] = await db.select({ runId: taskAssignments.runId }).from(taskAssignments)
    .innerJoin(nodeRuns, eq(nodeRuns.id, taskAssignments.runId))
    .where(and(eq(nodeRuns.applicationId, applicationId), eq(taskAssignments.userId, viewer.userId), holdsAssignment))
    .limit(1)
  if (!row) throw new DomainError(404, 'application_not_found')
}

interface AssignmentView { userId: string, submittedAt: Date | null, values: unknown }

// Blind panels: while a task is open, an assignee who hasn't submitted sees no one else's scorecard.
export function visibleAssignments<T extends AssignmentView>(runStatus: string, assignments: T[], viewer: Viewer): T[] {
  if (atLeastManager(viewer.level) || runStatus !== 'waiting_on_human') return assignments
  if (assignments.find(a => a.userId === viewer.userId)?.submittedAt) return assignments
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

  return {
    application: {
      id: app.id, status: app.status, outcome: app.outcome, currentNodeKey: app.currentNodeKey, createdAt: app.createdAt,
      answers: Object.fromEntries(Object.entries(app.answers as Record<string, unknown>).filter(([k]) => !hidden.has(k))),
    },
    candidate: { firstName: candidate.firstName, lastName: candidate.lastName, email: candidate.email, phone: candidate.phone },
    job,
    version: version.version,
    form: form.filter(f => !hidden.has(f.key)).map(({ key, label, type }) => ({ key, label, type })),
    nodes: (version.workflow as Graph).nodes.map(({ key, type, label }) => ({ key, type, label })),
    runs: runs.map(r => ({
      id: r.id, nodeKey: r.nodeKey, nodeType: r.nodeType, attempt: r.attempt, status: r.status,
      input: r.input, output: r.output, branchTaken: r.branchTaken, evaluation: r.evaluation, error: r.error, retries: r.retries,
      dueAt: r.dueAt, overdue: isOverdue(r, now), actorId: r.actorId, createdAt: r.createdAt, completedAt: r.completedAt,
      assignments: visibleAssignments(r.status, assignments.filter(a => a.runId === r.id), viewer).map(({ runId: _, ...a }) => a),
    })),
    events,
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

// Pipeline list for a job: every application with where it is and the state of its latest run.
export async function pipeline(db: Db, jobId: string) {
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId))
  if (!job) throw new DomainError(404, 'job_not_found')
  return db.select({
    id: applications.id, status: applications.status, outcome: applications.outcome, currentNodeKey: applications.currentNodeKey,
    createdAt: applications.createdAt, version: jobVersions.version,
    candidate: { firstName: candidates.firstName, lastName: candidates.lastName, email: candidates.email },
    runStatus: sql<string | null>`(select r.status from ${nodeRuns} r where r.application_id = ${applications.id} order by r.seq desc limit 1)`,
  }).from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobVersions, eq(jobVersions.id, applications.jobVersionId))
    .where(eq(applications.jobId, jobId))
    .orderBy(desc(applications.createdAt))
}

// Hires against openings, for every job that was ever published.
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
  return {
    jobs: rows.map(r => ({ ...r, fillRate: r.hired / r.openings })),
    totals: { jobs: rows.length, openings, hires, fillRate: openings ? hires / openings : 0 },
  }
}
