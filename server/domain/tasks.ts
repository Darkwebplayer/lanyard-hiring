import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { type HumanTaskConfig, REGISTRY } from '../../shared/workflow/registry'
import type { Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applications, bookings, candidates, jobs, jobVersions, nodeRuns, reminderLog, roles, taskAssignments, user } from '../db/schema'
import type { Email } from '../engine/email'
import { LOST_PENDING_MS, STALE_RUNNING_MS } from '../engine/engine'
import { accessLevel, atLeastManager } from './access'
import { blindNodes, heldThrough, isOverdue, visibleAssignments, type Viewer } from './applications'
import { DomainError } from './errors'

const runRows = (db: Db) => db.select({
  runId: nodeRuns.id, nodeKey: nodeRuns.nodeKey, nodeType: nodeRuns.nodeType, status: nodeRuns.status, input: nodeRuns.input,
  dueAt: nodeRuns.dueAt, error: nodeRuns.error, retries: nodeRuns.retries, createdAt: nodeRuns.createdAt,
  applicationId: applications.id, jobVersionId: applications.jobVersionId,
  firstName: candidates.firstName, lastName: candidates.lastName, jobId: jobs.id, jobTitle: jobs.title,
  bookingId: bookings.id, bookedAt: bookings.startsAt, bookingCancelledAt: bookings.cancelledAt, bookingMin: bookings.durationMin, bookingWhere: bookings.location,
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
  booking: r.bookingId ? { startsAt: r.bookedAt, cancelledAt: r.bookingCancelledAt } : null, // the candidate's booking link exists; startsAt once they picked
})

async function humanConfigs(db: Db, versionIds: string[]) {
  const versions = versionIds.length ? await db.select({ id: jobVersions.id, workflow: jobVersions.workflow }).from(jobVersions).where(inArray(jobVersions.id, versionIds)) : []
  return (versionId: string, nodeKey: string) => {
    const node = (versions.find(v => v.id === versionId)!.workflow as Graph).nodes.find(n => n.key === nodeKey)!
    return REGISTRY.human_task!.config.parse(node.config ?? {}) as HumanTaskConfig
  }
}

// The inbox. Everyone gets their open tasks, and interviews of theirs called off in the last week (an accepted
// offer, a close); managers also get what needs a person to unstick it.
export async function listTasks(db: Db, viewer: Viewer, adminEmail: string, now: Date) {
  const held = await runRows(db).innerJoin(taskAssignments, eq(taskAssignments.runId, nodeRuns.id))
    .where(and(eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt), isNull(taskAssignments.submittedAt), eq(nodeRuns.status, 'waiting_on_human')))
    .orderBy(asc(nodeRuns.dueAt), asc(nodeRuns.seq))
  const grabs = await grabsFor(db, viewer.userId, held)
  const mine = held.filter(r => !grabs.has(r.runId))
  const open = held.filter(r => grabs.has(r.runId)).map(r => ({ ...view(r, now), grab: grabs.get(r.runId)! }))
  const calledOff = (await runRows(db).innerJoin(taskAssignments, eq(taskAssignments.runId, nodeRuns.id))
    .where(and(eq(taskAssignments.userId, viewer.userId), isNotNull(bookings.cancelledAt), gt(bookings.cancelledAt, new Date(now.getTime() - 7 * 86_400_000))))
    .orderBy(desc(bookings.cancelledAt))).map(r => view(r, now))
  if (!atLeastManager(viewer.level)) return { mine: mine.map(r => view(r, now)), open, calledOff }

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
    return reachable < (r.nodeType === 'human_task' ? config(r.jobVersionId, r.nodeKey).min_submissions : 1)
  })

  return {
    mine: mine.map(r => view(r, now)),
    open,
    calledOff,
    overdue: waiting.filter(r => isOverdue(r, now)).map(r => view(r, now)),
    blocked: blocked.map(r => view(r, now)),
    failed: failed.map(r => view(r, now)),
    stuck: stuck.map(r => view(r, now)),
  }
}

// Up for grabs: a human task sent to more people than it needs, that this person hasn't taken. Keyed by run,
// with who else still has it and who has taken it. Tasks missing from the map are simply theirs.
async function grabsFor(db: Db, userId: string, rows: RunRow[]) {
  const human = rows.filter(r => r.nodeType === 'human_task')
  const out = new Map<string, { others: string[], taken: string[], need: number }>()
  if (!human.length) return out
  const holders = await db.select({ runId: taskAssignments.runId, userId: taskAssignments.userId, name: user.name, claimedAt: taskAssignments.claimedAt, submittedAt: taskAssignments.submittedAt })
    .from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId))
    .where(and(inArray(taskAssignments.runId, human.map(r => r.runId)), or(isNull(taskAssignments.closedAt), isNotNull(taskAssignments.submittedAt))))
    .orderBy(asc(user.name))
  const config = await humanConfigs(db, [...new Set(human.map(r => r.jobVersionId))])
  for (const r of human) {
    const live = holders.filter(h => h.runId === r.runId)
    const me = live.find(h => h.userId === userId)
    const need = config(r.jobVersionId, r.nodeKey).min_submissions
    if (!me || me.claimedAt || me.submittedAt || live.length <= need) continue
    const others = live.filter(h => h.userId !== userId)
    out.set(r.runId, { others: others.map(h => h.name), taken: others.filter(h => h.claimedAt || h.submittedAt).map(h => h.name), need })
  }
  return out
}

// What this person finished or passed on, newest first. The chip is their answer to the scorecard's first
// yes/no question (usually "Hire?").
// ponytail: the latest 300, filtered on the client; page it when someone's history outgrows that
export async function listDone(db: Db, viewer: Viewer, now: Date) {
  const mine = await db.select({ runId: taskAssignments.runId, submittedAt: taskAssignments.submittedAt, passedAt: taskAssignments.passedAt, values: taskAssignments.values })
    .from(taskAssignments)
    .where(and(eq(taskAssignments.userId, viewer.userId), or(isNotNull(taskAssignments.submittedAt), isNotNull(taskAssignments.passedAt))))
    .orderBy(desc(sql`coalesce(${taskAssignments.submittedAt}, ${taskAssignments.passedAt})`))
    .limit(300)
  if (!mine.length) return []
  const rows = await runRows(db).where(inArray(nodeRuns.id, mine.map(m => m.runId)))
  const config = await humanConfigs(db, [...new Set(rows.filter(r => r.nodeType === 'human_task').map(r => r.jobVersionId))])
  return mine.map((m) => {
    const r = rows.find(r => r.runId === m.runId)!
    const yesNo = r.nodeType === 'human_task' ? config(r.jobVersionId, r.nodeKey).scorecard.find(f => f.type === 'boolean') : undefined
    const v = (m.values as Record<string, unknown> | null)?.[yesNo?.key ?? '']
    return {
      ...view(r, now),
      doneAt: (m.submittedAt ?? m.passedAt)!,
      passed: !m.submittedAt,
      answer: yesNo && typeof v === 'boolean' ? { label: yesNo.label, yes: v } : null,
    }
  })
}

// Booked interviews between two times: this person's, or (managers) everyone's. Plus, for their own,
// the ones still waiting for the candidate to pick a time.
export async function listSchedule(db: Db, viewer: Viewer, from: Date, to: Date, everyone: boolean, now: Date) {
  if (everyone && !atLeastManager(viewer.level)) throw new DomainError(403, 'forbidden')
  const booked = await runRows(db).where(and(ne(nodeRuns.status, 'cancelled'), isNull(bookings.cancelledAt), gte(bookings.startsAt, from), lt(bookings.startsAt, to)))
    .orderBy(asc(bookings.startsAt))
  const people = booked.length
    ? await db.select({ runId: taskAssignments.runId, id: user.id, name: user.name }).from(taskAssignments)
        .innerJoin(nodeRuns, eq(nodeRuns.id, taskAssignments.runId)).innerJoin(user, eq(user.id, taskAssignments.userId))
        .where(and(inArray(taskAssignments.runId, booked.map(r => r.runId)), heldThrough)).orderBy(asc(user.name))
    : []
  const events = booked.map(r => ({
    ...view(r, now), startsAt: r.bookedAt!, durationMin: r.bookingMin!, location: r.bookingWhere,
    people: people.filter(p => p.runId === r.runId).map(p => ({ id: p.id, name: p.name })),
  })).filter(e => everyone || e.people.some(p => p.id === viewer.userId))
  const waiting = everyone ? [] : (await runRows(db).innerJoin(taskAssignments, eq(taskAssignments.runId, nodeRuns.id))
    .where(and(eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt), eq(nodeRuns.status, 'waiting_on_human'), isNotNull(bookings.id), isNull(bookings.startsAt)))
    .orderBy(asc(nodeRuns.dueAt))).map(r => view(r, now))
  return { events, waiting }
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
    grab: (await grabsFor(db, viewer.userId, [row])).get(row.runId) ?? null, // up for grabs, for this viewer
    plan: config.booking ? { durationMin: config.booking.duration_min, where: config.booking.where ?? null } : null, // before the link exists
    instructions: (row.input as { instructions?: string } | null)?.instructions ?? null,
    scorecard: config.scorecard,
    offer: !!config.offer, // Make offer: answered through the offer, not a scorecard
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
    runId: nodeRuns.id, input: nodeRuns.input, dueAt: nodeRuns.dueAt, nodeType: nodeRuns.nodeType, applicationId: nodeRuns.applicationId,
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
        text: r.nodeType === 'request_documents'
          ? `Hi ${r.name},\n\n"${title}" was due on ${r.dueAt!.toISOString().slice(0, 10)} and some documents are still missing. You can send the candidate a reminder or mark what you have as received.\n\n${appUrl}/candidates/${r.applicationId}`
          : `Hi ${r.name},\n\n"${title}" was due on ${r.dueAt!.toISOString().slice(0, 10)} and is still waiting for your scorecard.\n\n${appUrl}/tasks/${r.runId}`,
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
