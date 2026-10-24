import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { type HumanTaskConfig, REGISTRY } from '../../shared/workflow/registry'
import type { Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applications, bookings, candidates, jobs, jobVersions, nodeRuns, reminderLog, roles, taskAssignments, user } from '../db/schema'
import type { Email } from '../engine/email'
import { LOST_PENDING_MS, STALE_RUNNING_MS } from '../engine/engine'
import { accessLevel, atLeastManager } from './access'
import { blindNodes, isOverdue, visibleAssignments, type Viewer } from './applications'
import { DomainError } from './errors'

const runRows = (db: Db) => db.select({
  runId: nodeRuns.id, nodeKey: nodeRuns.nodeKey, nodeType: nodeRuns.nodeType, status: nodeRuns.status, input: nodeRuns.input,
  dueAt: nodeRuns.dueAt, error: nodeRuns.error, retries: nodeRuns.retries, createdAt: nodeRuns.createdAt,
  applicationId: applications.id, jobVersionId: applications.jobVersionId,
  firstName: candidates.firstName, lastName: candidates.lastName, jobId: jobs.id, jobTitle: jobs.title,
  bookingId: bookings.id, bookedAt: bookings.startsAt,
}).from(nodeRuns)
  .innerJoin(applications, eq(applications.id, nodeRuns.applicationId))
  .innerJoin(candidates, eq(candidates.id, applications.candidateId))
  .innerJoin(jobs, eq(jobs.id, applications.jobId))
  .leftJoin(bookings, eq(bookings.runId, nodeRuns.id))
type RunRow = Awaited<ReturnType<ReturnType<typeof runRows>['execute']>>[number]

const view = (r: RunRow, now: Date) => ({
  runId: r.runId, nodeKey: r.nodeKey, nodeType: r.nodeType, status: r.status,
  title: (r.input as { title?: string } | null)?.title ?? r.nodeKey,
  dueAt: r.dueAt, overdue: isOverdue(r, now), error: r.error, retries: r.retries, createdAt: r.createdAt,
  applicationId: r.applicationId, candidateName: `${r.firstName} ${r.lastName}`, jobId: r.jobId, jobTitle: r.jobTitle,
  booking: r.bookingId ? { startsAt: r.bookedAt } : null, // the candidate's booking link exists; startsAt once they picked
})

async function humanConfigs(db: Db, versionIds: string[]) {
  const versions = versionIds.length ? await db.select({ id: jobVersions.id, workflow: jobVersions.workflow }).from(jobVersions).where(inArray(jobVersions.id, versionIds)) : []
  return (versionId: string, nodeKey: string) => {
    const node = (versions.find(v => v.id === versionId)!.workflow as Graph).nodes.find(n => n.key === nodeKey)!
    return REGISTRY.human_task!.config.parse(node.config ?? {}) as HumanTaskConfig
  }
}

// The inbox. Everyone gets their open tasks; managers also get what needs a person to unstick it.
export async function listTasks(db: Db, viewer: Viewer, adminEmail: string, now: Date) {
  const mine = await runRows(db).innerJoin(taskAssignments, eq(taskAssignments.runId, nodeRuns.id))
    .where(and(eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt), isNull(taskAssignments.submittedAt), eq(nodeRuns.status, 'waiting_on_human')))
    .orderBy(asc(nodeRuns.dueAt), asc(nodeRuns.seq))
  if (!atLeastManager(viewer.level)) return { mine: mine.map(r => view(r, now)) }

  const t = now.getTime()
  const waiting = await runRows(db).where(eq(nodeRuns.status, 'waiting_on_human')).orderBy(asc(nodeRuns.dueAt), asc(nodeRuns.seq))
  // failed and still the latest run of a live application: nothing will happen until someone retries or moves it
  const failed = await runRows(db).where(and(eq(nodeRuns.status, 'failed'), eq(applications.status, 'active'),
    sql`not exists (select 1 from ${nodeRuns} later where later.application_id = ${nodeRuns.applicationId} and later.seq > ${nodeRuns.seq})`))
    .orderBy(asc(nodeRuns.seq))
  // the sweeper normally recovers these within minutes; showing up here means it isn't
  const stuck = await runRows(db).where(or(
    and(eq(nodeRuns.status, 'running'), lt(nodeRuns.claimedAt, new Date(t - STALE_RUNNING_MS))),
    and(eq(nodeRuns.status, 'pending'), lt(nodeRuns.nextAttemptAt, new Date(t - LOST_PENDING_MS))),
  )).orderBy(asc(nodeRuns.seq))

  // blocked: submissions so far plus open assignees who can still sign in can't reach min_submissions
  // ponytail: scans every waiting run per inbox load; precompute when waiting runs reach the thousands
  const holders = waiting.length
    ? await db.select({ runId: taskAssignments.runId, submittedAt: taskAssignments.submittedAt, closedAt: taskAssignments.closedAt, email: user.email, active: user.active, level: roles.level })
        .from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId)).leftJoin(roles, eq(roles.id, user.roleId))
        .where(inArray(taskAssignments.runId, waiting.map(r => r.runId)))
    : []
  const config = await humanConfigs(db, [...new Set(waiting.map(r => r.jobVersionId))])
  const blocked = waiting.filter((r) => {
    const reachable = holders.filter(h => h.runId === r.runId && (h.submittedAt || (!h.closedAt && accessLevel(h, h.level, adminEmail)))).length
    return reachable < config(r.jobVersionId, r.nodeKey).min_submissions
  })

  return {
    mine: mine.map(r => view(r, now)),
    overdue: waiting.filter(r => isOverdue(r, now)).map(r => view(r, now)),
    blocked: blocked.map(r => view(r, now)),
    failed: failed.map(r => view(r, now)),
    stuck: stuck.map(r => view(r, now)),
  }
}

// One task with its scorecard. Assignees (current, or past ones who submitted) and managers only.
export async function getTask(db: Db, viewer: Viewer, runId: string, now: Date) {
  const [row] = await runRows(db).where(and(eq(nodeRuns.id, runId), eq(nodeRuns.nodeType, 'human_task')))
  if (!row) throw new DomainError(404, 'task_not_found')
  const assignments = await db.select({
    userId: taskAssignments.userId, name: user.name, assignedAt: taskAssignments.assignedAt,
    submittedAt: taskAssignments.submittedAt, closedAt: taskAssignments.closedAt, values: taskAssignments.values,
  }).from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId))
    .where(eq(taskAssignments.runId, runId)).orderBy(asc(taskAssignments.assignedAt), asc(taskAssignments.userId))
  const mine = assignments.find(a => a.userId === viewer.userId)
  if (!atLeastManager(viewer.level) && !(mine && (!mine.closedAt || mine.submittedAt))) throw new DomainError(404, 'task_not_found')

  const config = (await humanConfigs(db, [row.jobVersionId]))(row.jobVersionId, row.nodeKey)
  return {
    ...view(row, now),
    instructions: (row.input as { instructions?: string } | null)?.instructions ?? null,
    scorecard: config.scorecard,
    minSubmissions: config.min_submissions,
    canSubmit: row.status === 'waiting_on_human' && !!mine && !mine.closedAt && !mine.submittedAt,
    assignments: visibleAssignments(row.nodeKey, assignments, viewer, await blindNodes(db, viewer, row.applicationId)),
  }
}

// Daily cron: one reminder per open assignee per overdue task per (UTC) day. Never moves the flow.
// Already-reminded pairs are excluded up front, so a rerun continues where a capped batch stopped.
// ponytail: a claim whose Worker dies before the send loses that day's reminder; tomorrow's still goes.
const REMINDER_BATCH = 500 // stays under the Workers subrequest limit (paid plan)
export async function sendReminders(db: Db, adminEmail: string, appUrl: string, now: Date, send: (key: string, email: Email) => Promise<unknown>) {
  const day = now.toISOString().slice(0, 10)
  const due = await db.select({
    runId: nodeRuns.id, input: nodeRuns.input, dueAt: nodeRuns.dueAt,
    userId: user.id, email: user.email, name: user.name, active: user.active, level: roles.level,
  }).from(taskAssignments)
    .innerJoin(nodeRuns, eq(nodeRuns.id, taskAssignments.runId))
    .innerJoin(user, eq(user.id, taskAssignments.userId)).leftJoin(roles, eq(roles.id, user.roleId))
    .where(and(eq(nodeRuns.status, 'waiting_on_human'), lt(nodeRuns.dueAt, now), isNull(taskAssignments.closedAt), isNull(taskAssignments.submittedAt),
      sql`not exists (select 1 from ${reminderLog} l where l.run_id = ${nodeRuns.id} and l.user_id = ${user.id} and l.day = ${day})`))
    .orderBy(asc(nodeRuns.dueAt))
    .limit(REMINDER_BATCH)

  let sent = 0
  for (const r of due) {
    if (!accessLevel(r, r.level, adminEmail)) continue
    // claim the day first, so a rerun or an overlapping cron skips it
    const [claimed] = await db.insert(reminderLog).values({ runId: r.runId, userId: r.userId, day }).onConflictDoNothing().returning()
    if (!claimed) continue
    const title = (r.input as { title?: string } | null)?.title ?? 'A task'
    try {
      await send(`reminder:${r.runId}:${r.userId}:${day}`, {
        to: r.email,
        subject: `Overdue: ${title}`,
        text: `Hi ${r.name},\n\n"${title}" was due on ${r.dueAt!.toISOString().slice(0, 10)} and is still waiting for your scorecard.\n\n${appUrl}/tasks/${r.runId}`,
      })
      sent++
    }
    catch (e) {
      console.error('[reminders] send failed', r.runId, r.userId, e)
      // release the claim so a rerun can try again; the provider's idempotency key stops a double send
      await db.delete(reminderLog).where(and(eq(reminderLog.runId, r.runId), eq(reminderLog.userId, r.userId), eq(reminderLog.day, day)))
        .catch(e2 => console.error('[reminders] release failed', r.runId, r.userId, e2))
    }
  }
  return { due: due.length, sent }
}
