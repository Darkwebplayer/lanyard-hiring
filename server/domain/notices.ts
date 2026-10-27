import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { nodeLabel, runErrorText } from '../../app/utils/nodes'
import { type HumanTaskConfig, REGISTRY } from '../../shared/workflow/registry'
import type { Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applicationEvents, applications, candidates, jobs, jobVersions, nodeRuns, noticeMarks, noticeState, taskAssignments, user } from '../db/schema'
import { atLeastManager } from './access'
import type { Viewer } from './applications'

// The Updates tray. Items are read from application_events, never written separately, so the tray and the
// candidate page can't disagree. Only urgent and important items count on the bell; fyi ones are listed quietly;
// everything else (claims, reminders, side effects of someone's move) never shows. Nobody hears about their own action.

export type Tier = 'urgent' | 'important' | 'fyi'
export type NoticeCat = 'problems' | 'candidates' | 'tasks' | 'offers'
export interface Notice { seq: number, at: string, tier: Tier, cat: NoticeCat, text: string, to: string, read: boolean }

const WINDOW_MS = 30 * 86_400_000
const SCAN = 500
const KEEP = 100
const RANK: Record<Tier, number> = { urgent: 3, important: 2, fyi: 1 }

const MANAGER_TYPES = ['run_failed', 'task_passed', 'task_submitted', 'booked', 'times_offered', 'times_none', 'times_requested', 'booking_declined', 'documents_in', 'offer_answered', 'offer_made', 'offer_withdrawn', 'manual_move', 'closed', 'application_submitted']
const EMPLOYEE_TYPES = ['task_assigned', 'task_reassigned', 'booked', 'booking_cancelled', 'documents_in', 'times_offered', 'times_none', 'times_requested', 'booking_declined']

type Ev = Awaited<ReturnType<typeof scan>>[number]
const scan = (db: Db, types: string[], where: ReturnType<typeof and>) => db.select({
  seq: applicationEvents.seq, type: applicationEvents.type, data: applicationEvents.data, actorId: applicationEvents.actorId,
  createdAt: applicationEvents.createdAt, actorName: user.name, applicationId: applications.id, jobVersionId: applications.jobVersionId, appStatus: applications.status,
  first: candidates.firstName, last: candidates.lastName, jobId: jobs.id, jobTitle: jobs.title,
}).from(applicationEvents)
  .innerJoin(applications, eq(applications.id, applicationEvents.applicationId))
  .innerJoin(candidates, eq(candidates.id, applications.candidateId))
  .innerJoin(jobs, eq(jobs.id, applications.jobId))
  .leftJoin(user, eq(user.id, applicationEvents.actorId))
  .where(and(inArray(applicationEvents.type, types), where))
  .orderBy(desc(applicationEvents.seq)).limit(SCAN)

async function state(db: Db, userId: string) {
  const [s] = await db.select().from(noticeState).where(eq(noticeState.userId, userId))
  return { seenSeq: s?.seenSeq ?? 0, clearedSeq: s?.clearedSeq ?? 0 }
}

// count: only what is newer than the last look, for the bell's poll. Same rules as the list, so the two agree.
// tz and locale: the viewer's, for interview times and "per day" groups
export async function listNotices(db: Db, viewer: Viewer, tz: string, now: Date, count = false, locale = 'en-GB') {
  const { seenSeq, clearedSeq } = await state(db, viewer.userId)
  const manager = atLeastManager(viewer.level)
  const after = count ? Math.max(seenSeq, clearedSeq) : clearedSeq
  const mine = manager
    ? undefined
    : inArray(applicationEvents.applicationId, db.select({ id: nodeRuns.applicationId }).from(nodeRuns)
        .innerJoin(taskAssignments, eq(taskAssignments.runId, nodeRuns.id)).where(eq(taskAssignments.userId, viewer.userId)))
  // the link answer is filed under whoever made the offer, but the candidate gave it: that person must hear it
  const notMine = or(sql`${applicationEvents.actorId} is distinct from ${viewer.userId}`,
    and(eq(applicationEvents.type, 'offer_answered'), sql`${applicationEvents.data}->>'via' = 'link'`))
  const events = await scan(db, manager ? MANAGER_TYPES : EMPLOYEE_TYPES, and(
    gt(applicationEvents.seq, after), gt(applicationEvents.createdAt, new Date(now.getTime() - WINDOW_MS)), notMine, mine,
  ))
  const latestSeq = events[0]?.seq ?? after
  if (!events.length) return { items: [] as Notice[], seenSeq, latestSeq, unread: 0, urgent: 0 }

  // steps by name, from the version each application runs on
  const versionIds = [...new Set(events.map(e => e.jobVersionId))]
  const runIds = [...new Set(events.map(e => (e.data as { runId?: string }).runId).filter((r): r is string => !!r))]
  // independent lookups: one round trip's wait, not four
  const failedApps = [...new Set(events.filter(e => e.type === 'run_failed').map(e => e.applicationId))]
  const [versions, runs, holders, marks, latest] = await Promise.all([
    db.select({ id: jobVersions.id, workflow: jobVersions.workflow }).from(jobVersions).where(inArray(jobVersions.id, versionIds)),
    runIds.length ? db.select({ id: nodeRuns.id, nodeKey: nodeRuns.nodeKey, nodeType: nodeRuns.nodeType, status: nodeRuns.status }).from(nodeRuns).where(inArray(nodeRuns.id, runIds)) : [],
    runIds.length ? db.select().from(taskAssignments).where(inArray(taskAssignments.runId, runIds)) : [],
    db.select().from(noticeMarks).where(and(eq(noticeMarks.userId, viewer.userId), gt(noticeMarks.seq, clearedSeq))),
    // where each application with a failure stands now: a retry or a move leaves a newer run behind
    failedApps.length
      ? db.selectDistinctOn([nodeRuns.applicationId], { applicationId: nodeRuns.applicationId, nodeKey: nodeRuns.nodeKey, status: nodeRuns.status })
          .from(nodeRuns).where(inArray(nodeRuns.applicationId, failedApps)).orderBy(nodeRuns.applicationId, desc(nodeRuns.seq))
      : [],
  ])
  const nodeOf = (versionId: string, key: string) => (versions.find(v => v.id === versionId)?.workflow as Graph | undefined)?.nodes.find(n => n.key === key)
  const read = new Set(marks.map(m => m.seq))
  const dismissed = new Set(marks.filter(m => m.dismissed).map(m => m.seq))

  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)

  function describe(e: Ev): Omit<Notice, 'seq' | 'at' | 'read'> | null {
    const d = e.data as Record<string, any>
    const who = e.actorName ?? 'Someone'
    const cand = `${e.first} ${e.last}`
    const run = runs.find(r => r.id === d.runId)
    const key: string = d.node ?? run?.nodeKey ?? ''
    const node = nodeOf(e.jobVersionId, key)
    const step = node ? nodeLabel(node) : 'a step'
    const page = `/candidates/${e.applicationId}`
    const atStep = key ? `${page}#node:${key}` : page
    // scheduling: the same words for managers who interview too; a panel's "can you make these?" only for those on it
    const holds = holders.some(h => h.runId === d.runId && h.userId === viewer.userId && !h.closedAt && !h.passedAt)
    const toTask = `/inbox/${d.runId}`
    if (e.type === 'times_offered') return holds && d.panel ? { tier: 'important', cat: 'tasks', text: `${who} offered ${d.count} ${d.count === 1 ? 'time' : 'times'} for ${cand}. Can you make them?`, to: toTask } : null
    if (e.type === 'times_none') return d.by === viewer.userId ? { tier: 'important', cat: 'tasks', text: `The panel can’t make any of the times for ${cand}. Offer new ones.`, to: toTask } : null
    if (e.type === 'times_requested') return holds ? { tier: 'important', cat: 'tasks', text: `${cand} asked for other times for ${step}`, to: toTask } : manager ? { tier: 'fyi', cat: 'tasks', text: `${cand} asked for other times for ${step}`, to: atStep } : null
    if (e.type === 'booking_declined') return holds || manager ? { tier: 'important', cat: 'candidates', text: `${cand} stepped back from ${step}`, to: holds ? toTask : atStep } : null

    if (!manager) {
      const held = holders.find(h => h.runId === d.runId && h.userId === viewer.userId)
      const task = `/inbox/${d.runId}`
      if (e.type === 'task_assigned' && (d.assignees as string[] | undefined)?.includes(viewer.userId)) return { tier: 'important', cat: 'tasks', text: `You have ${step} for ${cand}`, to: task }
      if (e.type === 'task_reassigned' && (d.add as string[] | undefined)?.includes(viewer.userId)) return { tier: 'important', cat: 'tasks', text: `${who} gave you ${step} for ${cand}`, to: task }
      if (e.type === 'task_reassigned' && (d.remove as string[] | undefined)?.includes(viewer.userId)) return { tier: 'fyi', cat: 'tasks', text: `${who} took you off ${step} for ${cand}`, to: '/inbox' }
      // passed on it: not theirs. A close also closes their assignment, so the call-off still reaches them.
      if (!held || held.passedAt) return null
      if (e.type === 'booking_cancelled') return { tier: 'important', cat: 'tasks', text: `${cand}’s ${step} on ${fmt(d.startsAt)} is off`, to: '/inbox' }
      if (held.closedAt && !held.submittedAt) return null // taken off it
      if (e.type === 'booked') return { tier: 'important', cat: 'tasks', text: d.previous ? `${cand} moved ${step} to ${fmt(d.startsAt)}` : `${cand} booked ${step} for ${fmt(d.startsAt)}`, to: task }
      if (e.type === 'documents_in') return { tier: 'important', cat: 'tasks', text: `${cand} sent every document for ${step}`, to: task }
      return null
    }

    switch (e.type) {
      case 'run_failed': {
        const text = `${step} couldn’t run for ${cand}. ${runErrorText(d.error).what}.`
        // still stopped there (the same rule as Needs attention); retried, moved or closed since: a quiet line
        const now = latest.find(l => l.applicationId === e.applicationId)
        const stopped = e.appStatus === 'active' && now?.status === 'failed' && now.nodeKey === key
        return { tier: stopped ? 'urgent' : 'fyi', cat: 'problems', text, to: atStep }
      }
      case 'task_passed': {
        // backing out only matters when it leaves the step short of people; reassigning someone settles it
        const need = run?.status === 'waiting_on_human' && run.nodeType === 'human_task' && node
          ? (REGISTRY.human_task!.config.parse(node.config ?? {}) as HumanTaskConfig).min_submissions - holders.filter(h => h.runId === run.id && (h.submittedAt || !h.closedAt)).length
          : 0
        return need > 0
          ? { tier: 'important', cat: 'problems', text: `${who} passed on ${step} for ${cand}. It needs ${need} more ${need === 1 ? 'person' : 'people'}.`, to: atStep }
          : { tier: 'fyi', cat: 'tasks', text: `${who} passed on ${step} for ${cand}`, to: atStep }
      }
      case 'task_submitted': return { tier: 'fyi', cat: 'tasks', text: `${who} finished ${step} for ${cand}`, to: atStep }
      case 'booked': return { tier: 'fyi', cat: 'tasks', text: d.previous ? `${cand} moved ${step} to ${fmt(d.startsAt)}` : `${cand} booked ${step} for ${fmt(d.startsAt)}`, to: atStep }
      case 'documents_in': return { tier: 'fyi', cat: 'tasks', text: `${cand} sent every document for ${step}`, to: atStep }
      case 'offer_answered': {
        const said = `${cand} ${d.accepted ? 'accepted' : 'declined'} the offer for ${e.jobTitle}`
        return { tier: 'important', cat: 'offers', text: d.via === 'link' ? said : `${said} (${who} recorded it)`, to: `${page}#offer-h` }
      }
      case 'offer_made': return { tier: 'fyi', cat: 'offers', text: `${who} made ${cand} an offer for ${e.jobTitle}`, to: `${page}#offer-h` }
      // with no actor it went with the flow's own close: not news
      case 'offer_withdrawn': return e.actorId ? { tier: 'fyi', cat: 'offers', text: `${who} withdrew ${cand}’s offer`, to: `${page}#offer-h` } : null
      case 'manual_move': {
        const close: string | undefined = d.to?.close
        if (close === 'hired') return { tier: 'important', cat: 'candidates', text: `${who} marked ${cand} hired for ${e.jobTitle}`, to: page }
        if (close) return { tier: 'fyi', cat: 'candidates', text: `${who} closed ${cand} as ${close}`, to: page }
        const there = nodeOf(e.jobVersionId, d.to?.node ?? '')
        const name = there ? nodeLabel(there) : 'another step'
        return { tier: 'fyi', cat: 'candidates', text: d.previous?.status === 'closed' ? `${who} reopened ${cand} at ${name}` : `${who} moved ${cand} to ${name}`, to: page }
      }
      // the flow reached a hired end on its own; manual closes are told by their manual_move, rejections by the flow are routine
      case 'closed': return d.outcome === 'hired' && !d.manual ? { tier: 'important', cat: 'candidates', text: `${cand} was hired for ${e.jobTitle}`, to: page } : null
      default: return null
    }
  }

  // One item per transaction: rows written together share created_at. The loudest row speaks for them, the cause
  // (lowest seq) on a tie, so a close doesn't also report the interview and offer it called off.
  const bursts = new Map<string, { e: Ev, n: NonNullable<ReturnType<typeof describe>> }>()
  const groups = new Map<string, Ev[]>()
  for (const e of events) {
    if (e.type === 'application_submitted') {
      const k = `${e.jobId}:${dayOf(e.createdAt)}`
      groups.set(k, [...groups.get(k) ?? [], e])
      continue
    }
    const n = describe(e)
    if (!n) continue
    const k = `${e.applicationId}:${e.createdAt.getTime()}`
    const was = bursts.get(k)
    if (!was || RANK[n.tier] > RANK[was.n.tier] || (RANK[n.tier] === RANK[was.n.tier] && e.seq < was.e.seq)) bursts.set(k, { e, n })
  }

  const items: Notice[] = [...bursts.values()]
    .filter(({ e }) => !dismissed.has(e.seq))
    .map(({ e, n }) => ({ seq: e.seq, at: e.createdAt.toISOString(), ...n, read: read.has(e.seq) }))
  // new applications: one line per job per day; dismissing it hides those so far, the next applicant starts it again
  for (const all of groups.values()) {
    const cut = all.findIndex(e => dismissed.has(e.seq)) // newest first
    const g = cut === -1 ? all : all.slice(0, cut)
    const head = g[0]
    if (!head) continue
    items.push({
      seq: head.seq, at: head.createdAt.toISOString(), tier: 'fyi', cat: 'candidates', read: read.has(head.seq),
      text: g.length === 1 ? `${head.first} ${head.last} applied for ${head.jobTitle}` : `${g.length} new applications for ${head.jobTitle}`,
      to: g.length === 1 ? `/candidates/${head.applicationId}` : `/jobs/${head.jobId}?view=list`,
    })
  }
  items.sort((a, b) => b.seq - a.seq)
  const kept = items.slice(0, KEEP)
  const fresh = kept.filter(i => i.tier !== 'fyi' && i.seq > seenSeq && !i.read)
  return { items: count ? [] : kept, seenSeq, latestSeq, unread: fresh.length, urgent: fresh.filter(i => i.tier === 'urgent').length }
}

// Looked at the tray (seen) or cleared it. Markers only move forward, so a stale tab can't bring old items back.
export async function markNotices(db: Db, userId: string, to: { seen?: number, cleared?: number }) {
  const seen = Math.max(to.seen ?? 0, to.cleared ?? 0)
  const cleared = to.cleared ?? 0
  await db.insert(noticeState).values({ userId, seenSeq: seen, clearedSeq: cleared }).onConflictDoUpdate({
    target: noticeState.userId,
    set: { seenSeq: sql`greatest(${noticeState.seenSeq}, ${seen})`, clearedSeq: sql`greatest(${noticeState.clearedSeq}, ${cleared})` },
  })
  return state(db, userId)
}

// Opened (read) or dismissed one item, by its head event.
export async function markNotice(db: Db, userId: string, seq: number, dismissed: boolean) {
  const row = db.insert(noticeMarks).values({ userId, seq, dismissed })
  // a click after a dismiss never brings it back
  await (dismissed ? row.onConflictDoUpdate({ target: [noticeMarks.userId, noticeMarks.seq], set: { dismissed: true } }) : row.onConflictDoNothing())
  return { seq, dismissed }
}
