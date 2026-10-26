import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { board, fileAnswer, hireReport, movable, pipeline, timeline, type Viewer } from '../server/domain/applications'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { getTask, listTasks, sendReminders } from '../server/domain/tasks'
import type { Email } from '../server/engine/email'
import { type AutoHandler, type EngineDeps, type Enqueued, executeAutoRun, HandlerError, moveApplication, reassignTask, startApplication, submitTask } from '../server/engine/engine'
import { testDb } from './db'

// Phase 7: inbox, task view (blind panels), timeline access, pipeline, hire report, reminders.

const ADMIN = 'admin@example.test'
let db: Db
let role: string
let t: Date
let queue: Enqueued[]
let ai: AutoHandler

const handlers: Record<string, AutoHandler> = {
  cv_parse: async () => ({ output: { text: 'Senior engineer', skills: ['TypeScript'], years_experience: 6, current_title: 'Engineer', file_sha256: 'x' } }),
  ai_review: args => ai(args),
  send_email: async () => ({ output: { sent: true } }),
}
const deps = (): EngineDeps => ({ db, handlers, adminEmail: ADMIN, now: () => t, enqueue: async (i) => { queue.push(...i) } })
const drain = async () => { while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId) }
const day = 86_400_000

const owner: Viewer = { userId: 'owner', level: 'manager' }
const emp = (userId: string): Viewer => ({ userId, level: 'employee' })
const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}
const score = { technical: 4, communication: 4, hire: true }

let n = 0
async function panelJob(openings = 1) {
  const tpl = structuredClone(STANDARD_HIRE)
  tpl.form.push({ key: 'gender', label: 'Gender', type: 'string', required: false, protected: true })
  const node = tpl.workflow.nodes.find(n => n.key === 'interview')!
  node.config = { ...(node.config as object), instructions: 'Ask {{candidate.first_name}} about on-call', assignees: { users: [], roles: [role], job_owner: false }, min_submissions: 2 }
  const { job } = await createJob(db, 'owner', { title: `Engineer ${++n}`, description: '', requirements: {}, openings, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, job.id, tpl)
  await publish(db, job.id, ADMIN)
  return (await db.query.jobs.findFirst({ where: eq(s.jobs.id, job.id) }))!
}
async function apply(job: typeof s.jobs.$inferSelect) {
  const [c] = await db.insert(s.candidates).values({ email: `c${++n}@example.test`, firstName: 'Jane', lastName: `Doe${n}` }).returning()
  const [a] = await db.insert(s.applications).values({
    jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!,
    answers: { cv: { key: `k${n}`, sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' }, gender: 'female' },
  }).returning()
  await startApplication(deps(), a!.id)
  await drain()
  return a!.id
}
const taskOf = async (appId: string) => (await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, appId)).orderBy(desc(s.nodeRuns.seq)).limit(1))[0]!
const latest = async (appId: string, nodeKey: string) =>
  (await db.select().from(s.nodeRuns).where(and(eq(s.nodeRuns.applicationId, appId), eq(s.nodeRuns.nodeKey, nodeKey))).orderBy(desc(s.nodeRuns.seq)).limit(1))[0]!
const setActive = (id: string, active: boolean) => db.update(s.user).set({ active }).where(eq(s.user.id, id))

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  ;[{ id: role }] = await db.insert(s.roles).values({ name: 'Interviewer', level: 'employee' }).returning() as any
  const [other] = await db.insert(s.roles).values({ name: 'Other', level: 'employee' }).returning()
  await db.insert(s.user).values([
    { id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id },
    { id: 'i1', email: 'i1@example.test', name: 'I1', roleId: role },
    { id: 'i2', email: 'i2@example.test', name: 'I2', roleId: role },
    { id: 'i3', email: 'i3@example.test', name: 'I3', roleId: role },
    { id: 'outsider', email: 'out@example.test', name: 'Out', roleId: other!.id },
  ])
})
afterAll(() => db.close())
beforeEach(() => {
  t = new Date('2026-10-20T09:00:00Z')
  queue = []
  ai = async () => ({ output: { skills_match: 90, experience: 80, overall: 85, summary: 'Strong' } })
})

describe('panel through the inbox', () => {
  it('two assignees finish a blind panel and the flow continues; the third is closed out', async () => {
    const id = await apply(await panelJob())
    const run = await taskOf(id)
    // three for a panel of two: up for grabs until two take it (a scorecard counts as taking it)
    for (const u of ['i1', 'i2', 'i3']) {
      const { mine, open } = await listTasks(db, emp(u), ADMIN, t)
      expect(mine).toEqual([])
      expect(open.find(m => m.runId === run.id)).toMatchObject({ title: expect.stringMatching(/^Interview Jane Doe/), overdue: false, grab: { need: 2, taken: [] } })
    }
    expect(await listTasks(db, emp('outsider'), ADMIN, t)).toMatchObject({ mine: [], open: [] })
    await rejects(getTask(db, emp('outsider'), run.id, t), 404, 'task_not_found')

    await submitTask(deps(), run.id, 'i1', score)
    // i2 hasn't submitted: blind to i1's scorecard; i1 and the manager see it
    const forI2 = await getTask(db, emp('i2'), run.id, t)
    expect(forI2).toMatchObject({ canSubmit: true, minSubmissions: 2, scorecard: expect.any(Array), instructions: 'Ask Jane about on-call' })
    expect(forI2.assignments.find(a => a.userId === 'i1')).toMatchObject({ submittedAt: expect.any(Date), values: null })
    expect((await getTask(db, emp('i1'), run.id, t)).assignments.find(a => a.userId === 'i1')!.values).toEqual(score)
    expect((await getTask(db, emp('i1'), run.id, t)).canSubmit).toBe(false)
    expect((await getTask(db, owner, run.id, t)).assignments.find(a => a.userId === 'i1')!.values).toEqual(score)
    // the timeline is blind the same way
    const tl = await timeline(db, emp('i2'), id, t)
    expect(tl.runs.find(r => r.id === run.id)!.assignments.find(a => a.userId === 'i1')!.values).toBeNull()

    expect(await submitTask(deps(), run.id, 'i2', { technical: 5, communication: 4, hire: true })).toEqual({ completed: true })
    await drain()
    expect(await db.query.applications.findFirst({ where: eq(s.applications.id, id) })).toMatchObject({ status: 'active', currentNodeKey: 'make_offer' })
    expect(await listTasks(db, emp('i3'), ADMIN, t)).toMatchObject({ mine: [], open: [] })
    // i3 was closed out without submitting: no access any more; i1 keeps it
    await rejects(getTask(db, emp('i3'), run.id, t), 404, 'task_not_found')
    await rejects(timeline(db, emp('i3'), id, t), 404, 'application_not_found')
    expect((await getTask(db, emp('i1'), run.id, t)).assignments.find(a => a.userId === 'i2')!.values).toMatchObject({ technical: 5 })
  })
})

describe('application access', () => {
  it('employees see only applications they hold a task on, without protected answers', async () => {
    const id = await apply(await panelJob())
    await rejects(timeline(db, emp('outsider'), id, t), 404, 'application_not_found')
    await rejects(fileAnswer(db, emp('outsider'), id, 'cv'), 404, 'application_not_found')

    const forI1 = await timeline(db, emp('i1'), id, t)
    expect(forI1.application.answers).not.toHaveProperty('gender')
    expect(forI1.form.map(f => f.key)).not.toContain('gender')
    expect(await fileAnswer(db, emp('i1'), id, 'cv')).toMatchObject({ mime: 'application/pdf' })
    await rejects(fileAnswer(db, emp('i1'), id, 'gender'), 404, 'file_not_found')
    await rejects(fileAnswer(db, emp('i1'), id, 'nope'), 404, 'file_not_found')

    const forOwner = await timeline(db, owner, id, t)
    expect(forOwner.application.answers).toMatchObject({ gender: 'female' })
    expect(forOwner.runs.map(r => r.nodeKey)).toEqual(['start', 'cv', 'ai', 'screen', 'interview'])
    expect(forOwner.events.map(e => e.type)).toEqual(['application_submitted', 'task_assigned'])
  })

  it('the timeline answers "why was this person rejected?"', async () => {
    ai = async () => ({ output: { skills_match: 10, experience: 10, overall: 10, summary: 'Weak' } })
    const id = await apply(await panelJob())
    await drain()
    const tl = await timeline(db, owner, id, t)
    const screen = tl.runs.find(r => r.nodeKey === 'screen')!
    expect(screen.branchTaken).toBe('reject')
    expect(screen.evaluation).toMatchObject({ branch: 'reject' })
    expect(tl.application).toMatchObject({ status: 'closed', outcome: 'rejected' })
  })

  it('a manual move is in the timeline with its reason and actor', async () => {
    const id = await apply(await panelJob())
    await moveApplication(deps(), id, { close: 'withdrawn' }, { reason: 'candidate withdrew by email' }, 'owner')
    const tl = await timeline(db, owner, id, t)
    expect(tl.events.find(e => e.type === 'manual_move')).toMatchObject({ actorName: 'Owner', data: { reason: 'candidate withdrew by email' } })
    // the move closed i1's assignment before they submitted: access goes with it
    await rejects(timeline(db, emp('i1'), id, t), 404, 'application_not_found')
  })
})

describe('manager inbox', () => {
  it('lists overdue, blocked, failed and stuck runs; employees get only their own tasks', async () => {
    const job = await panelJob()
    const overdueApp = await apply(job)
    const blockedApp = await apply(job)
    const failedApp = await (async () => {
      ai = async () => { throw new HandlerError('invalid_config', false) }
      return apply(job)
    })()
    ai = async () => ({ output: { skills_match: 90, experience: 80, overall: 85, summary: 'Strong' } })
    const stuckApp = await apply(job)
    const stuckRun = await taskOf(stuckApp)
    // pretend a worker claimed this run 20 minutes ago and died
    await db.update(s.nodeRuns).set({ status: 'running', claimedAt: new Date(t.getTime() - 20 * 60_000) }).where(eq(s.nodeRuns.id, stuckRun.id))

    // blocked: one submitted, i2 and i3 can't sign in any more → 1 < 2
    const blockedRun = await taskOf(blockedApp)
    await submitTask(deps(), blockedRun.id, 'i1', score)
    await setActive('i2', false)
    await setActive('i3', false)
    try {
      const later = new Date(t.getTime() + 6 * day) // interview is due after 5 days
      const inbox = await listTasks(db, owner, ADMIN, later)
      const ids = (k: keyof typeof inbox) => inbox[k]!.map(r => r.applicationId)
      expect(ids('overdue')).toEqual(expect.arrayContaining([overdueApp, blockedApp]))
      expect(inbox.overdue!.every(r => r.overdue)).toBe(true)
      expect(ids('blocked')).toContain(blockedApp)
      expect(ids('blocked')).toContain(overdueApp) // nobody submitted, and only i1 can still sign in
      expect(inbox.failed!.find(r => r.applicationId === failedApp)).toMatchObject({ nodeKey: 'ai', error: 'invalid_config' })
      expect(ids('stuck')).toContain(stuckApp)

      const forI1 = await listTasks(db, emp('i1'), ADMIN, later)
      expect(Object.keys(forI1)).toEqual(['mine', 'open', 'calledOff'])
      expect(forI1.open.map(r => r.applicationId)).toContain(overdueApp) // a panel of 2 from 3: up for grabs
      expect([...forI1.mine, ...forI1.open].map(r => r.applicationId)).not.toContain(blockedApp) // already submitted
    }
    finally {
      await setActive('i2', true)
      await setActive('i3', true)
    }
    // re-enabled: no longer blocked
    expect((await listTasks(db, owner, ADMIN, t)).blocked!.map(r => r.applicationId)).not.toContain(blockedApp)
  })
})

describe('reminders', () => {
  it('one per open assignee per overdue task per day, never twice; a failed send can be retried', async () => {
    await db.delete(s.reminderLog)
    // close every other open task so only this one is overdue
    await db.update(s.nodeRuns).set({ status: 'cancelled' }).where(eq(s.nodeRuns.status, 'waiting_on_human'))
    const id = await apply(await panelJob())
    const run = await taskOf(id)
    await submitTask(deps(), run.id, 'i1', score) // submitted: no reminder
    await setActive('i3', false) // can't sign in: no reminder
    try {
      const sent: { key: string, email: Email }[] = []
      const send = async (key: string, email: Email) => { sent.push({ key, email }) }
      const day6 = new Date(t.getTime() + 6 * day)

      expect(await sendReminders(db, ADMIN, 'https://app.test', new Date(t.getTime() + day), send)).toEqual({ due: 0, sent: 0 }) // not due yet
      expect(await sendReminders(db, ADMIN, 'https://app.test', day6, send)).toMatchObject({ sent: 1 })
      expect(sent).toEqual([{ key: `reminder:${run.id}:i2:2026-10-26`, email: expect.objectContaining({ to: 'i2@example.test', text: expect.stringContaining(`https://app.test/tasks/${run.id}`) }) }])
      expect(await sendReminders(db, ADMIN, 'https://app.test', new Date(day6.getTime() + 3_600_000), send)).toMatchObject({ sent: 0 }) // same day rerun
      expect(sent).toHaveLength(1)

      // next day: the provider is down → claim released, a rerun sends it
      const day7 = new Date(day6.getTime() + day)
      expect(await sendReminders(db, ADMIN, 'https://app.test', day7, async () => { throw new Error('down') })).toMatchObject({ sent: 0 })
      expect(await sendReminders(db, ADMIN, 'https://app.test', day7, send)).toMatchObject({ sent: 1 })
      expect(sent.map(s => s.key)).toEqual([`reminder:${run.id}:i2:2026-10-26`, `reminder:${run.id}:i2:2026-10-27`])

      // reminders never move the flow
      expect(await taskOf(id)).toMatchObject({ id: run.id, status: 'waiting_on_human' })
    }
    finally {
      await setActive('i3', true)
    }
  })
})

describe('pipeline and hire report', () => {
  it('lists a job\'s applications with their latest run, and hires against openings', async () => {
    const job = await panelJob(2)
    const hired = await apply(job)
    const waiting = await apply(job)
    const r = await taskOf(hired)
    await submitTask(deps(), r.id, 'i1', score)
    await submitTask(deps(), r.id, 'i2', score)
    await drain()
    await moveApplication(deps(), hired, { node: 'hired' }, { reason: 'Accepted on the phone' }, 'owner') // past Make offer

    const list = await pipeline(db, job.id)
    expect(list.map(a => [a.id, a.status, a.outcome, a.currentNodeKey, a.runStatus])).toEqual([
      [waiting, 'active', null, 'interview', 'waiting_on_human'],
      [hired, 'closed', 'hired', expect.any(String), 'completed'],
    ])
    expect(list[0]!.candidate).toMatchObject({ firstName: 'Jane' })
    // who holds the waiting candidate, and by when; a closed application holds nobody
    expect(list[0]!.assignees.map(a => [a.name, a.submitted])).toEqual([['I1', false], ['I2', false], ['I3', false]])
    expect(new Date(list[0]!.dueAt!).getTime()).toBe(t.getTime() + 5 * day)
    expect(list[1]!.assignees).toEqual([])
    await rejects(pipeline(db, crypto.randomUUID()), 404, 'job_not_found')

    const report = await hireReport(db)
    expect(report.jobs.find(j => j.id === job.id)).toMatchObject({ openings: 2, applications: 2, hired: 1, fillRate: 0.5 })
    expect(report.totals.hires).toBe(report.jobs.reduce((n, j) => n + j.hired, 0))
    expect(report.totals.jobs).toBe(report.jobs.length)
  })
})

describe('who was hired', () => {
  it('lists hires with how they were hired; no offer means no start date', async () => {
    const job = await panelJob(2)
    const a = await apply(job)
    const b = await apply(job)
    await moveApplication(deps(), a, { close: 'hired' }, { reason: 'hired on the spot' }, 'owner')
    const { hired } = await hireReport(db)
    expect(hired.find(h => h.id === a)).toMatchObject({ jobId: job.id, firstName: 'Jane', how: 'hand', startDate: null, documents: null, hiredAt: expect.anything() })
    expect(hired.some(h => h.id === b)).toBe(false)
  })
})

describe('board', () => {
  it('counts per step, searches and pages the list, and moves only those still where the board saw them', async () => {
    const job = await panelJob()
    const a = await apply(job)
    const b = await apply(job)

    const bd = await board(db, job.id, t)
    expect(bd.counts).toEqual([{ key: 'interview', status: 'active', outcome: null, n: 2, failed: 0, overdue: 0 }])
    expect(bd.stages?.map(st => st.name)).toEqual(['Screening', 'Interview', 'Offer', 'Not moving on'])
    expect(bd.steps.map(st => st.key)).toContain('interview')
    expect((await board(db, job.id, new Date(t.getTime() + 6 * day))).counts[0]).toMatchObject({ n: 2, overdue: 2 })

    const [cand] = await db.select().from(s.candidates).innerJoin(s.applications, eq(s.applications.candidateId, s.candidates.id)).where(eq(s.applications.id, b))
    expect((await pipeline(db, job.id, { q: cand!.candidates.lastName })).map(r => r.id)).toEqual([b])
    expect((await pipeline(db, job.id, { q: '100%' }))).toEqual([])
    expect((await pipeline(db, job.id, { step: 'interview', limit: 1 })).length).toBe(1)
    expect((await pipeline(db, job.id, { show: 'hired' }))).toEqual([])
    // a whole stage: several steps at once; the total counts all matches, not the page
    expect((await pipeline(db, job.id, { step: 'cv,interview', limit: 1 }))[0]!.total).toBe(2)
    // the board carries the first people of each group, newest first, same rows as the list
    expect(bd.preview.map(r => r.id)).toEqual((await pipeline(db, job.id, { step: 'interview' })).map(r => r.id))

    // a step missing from the pinned flow is counted out, not attempted
    expect(await movable(db, job.id, { node: 'interview' }, { node: 'nope' })).toMatchObject({ ids: [], notInVersion: 2 })
    expect((await movable(db, job.id, { node: 'interview' }, { close: 'rejected' }, [a])).ids).toEqual([a])
    expect((await movable(db, job.id, { node: 'interview' }, { close: 'rejected' }, undefined, [a])).ids).toEqual([b])

    // stale snapshot: the board saw `a` at cv, it is at interview, so nothing happens
    expect(await moveApplication(deps(), a, { close: 'rejected' }, { reasonCode: 'Other', reason: 'r' }, 'owner', { node: 'cv' })).toMatchObject({ moved: false, status: 'active', currentNodeKey: 'interview' })
    expect(await moveApplication(deps(), a, { close: 'rejected' }, { reasonCode: 'Other', reason: 'r' }, 'owner', { node: 'interview' })).toMatchObject({ moved: true, status: 'closed', outcome: 'rejected' })
    // a redelivered message finds it closed and does nothing
    expect((await moveApplication(deps(), a, { close: 'rejected' }, { reasonCode: 'Other', reason: 'r' }, 'owner', { node: 'interview' })).moved).toBe(false)
    expect(await moveApplication(deps(), a, { node: 'manual_review' }, { reason: 'back' }, 'owner', { closed: 'rejected' })).toMatchObject({ moved: true, status: 'active', currentNodeKey: 'manual_review' })
  })
})

describe('review round 2', () => {
  it('employees get no run data (it can carry protected answers); managers do', async () => {
    const id = await apply(await panelJob())
    const forI1 = await timeline(db, emp('i1'), id, t)
    for (const r of forI1.runs) {
      expect(r).not.toHaveProperty('input')
      expect(r).not.toHaveProperty('output')
      expect(r).not.toHaveProperty('evaluation')
    }
    expect(forI1.runs.find(r => r.nodeKey === 'screen')!.branchTaken).toBe('shortlist') // the path is still visible
    expect((await timeline(db, owner, id, t)).runs.find(r => r.nodeKey === 'screen')).toHaveProperty('evaluation')
  })

  it('blind panel holds across attempts: a re-opened interview hides the earlier scores', async () => {
    const id = await apply(await panelJob())
    const first = await taskOf(id)
    await submitTask(deps(), first.id, 'i1', score)
    await moveApplication(deps(), id, { node: 'interview' }, { reason: 'redo interview' }, 'owner')
    const second = await taskOf(id)
    expect(second.id).not.toBe(first.id)
    const i1Old = (await timeline(db, emp('i2'), id, t)).runs.find(r => r.id === first.id)
    // i2 lost access to attempt 1 when it was cancelled, but still sees it in the timeline: values must stay hidden
    expect(i1Old!.assignments.find(a => a.userId === 'i1')!.values).toBeNull()
    await submitTask(deps(), second.id, 'i2', score)
    expect((await timeline(db, emp('i2'), id, t)).runs.find(r => r.id === first.id)!.assignments.find(a => a.userId === 'i1')!.values).toEqual(score)
  })

  it('closing a closed application is refused; the outcome changes only through a reopen', async () => {
    const id = await apply(await panelJob())
    await moveApplication(deps(), id, { close: 'rejected' }, { reasonCode: 'Other', reason: 'not a fit' }, 'owner')
    await rejects(moveApplication(deps(), id, { close: 'hired' }, { reason: 'oops' }, 'owner'), 409, 'already_closed')
    expect(await db.query.applications.findFirst({ where: eq(s.applications.id, id) })).toMatchObject({ outcome: 'rejected' })
  })

  it('reassign cannot strand a task below min_submissions; unknown removals are not recorded', async () => {
    const id = await apply(await panelJob())
    const run = await taskOf(id)
    await rejects(reassignTask(deps(), run.id, { add: [], remove: ['i1', 'i2', 'i3'] }, 'owner'), 422, 'below_min_submissions')
    expect((await db.select().from(s.taskAssignments).where(eq(s.taskAssignments.runId, run.id))).every(a => !a.closedAt)) // rolled back
    await reassignTask(deps(), run.id, { add: [], remove: ['i3', 'nobody'] }, 'owner')
    const [ev] = await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, id), eq(s.applicationEvents.type, 'task_reassigned')))
    expect(ev!.data).toMatchObject({ remove: ['i3'] })
  })

  it('a node config that no longer parses fails at once with invalid_config', async () => {
    const job = await panelJob()
    const [c] = await db.insert(s.candidates).values({ email: `c${++n}@example.test`, firstName: 'Jane', lastName: 'Doe' }).returning()
    const [a] = await db.insert(s.applications).values({ jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!, answers: {} }).returning()
    await startApplication(deps(), a!.id) // cv queued
    const [v] = await db.select().from(s.jobVersions).where(eq(s.jobVersions.id, job.publishedVersionId!))
    const graph = v!.workflow as typeof STANDARD_HIRE.workflow
    graph.nodes.find(n => n.key === 'cv')!.config = { file_field: 42 }
    await db.update(s.jobVersions).set({ workflow: graph }).where(eq(s.jobVersions.id, v!.id))
    await drain()
    expect(await taskOf(a!.id)).toMatchObject({ nodeKey: 'cv', status: 'failed', retries: 0 })
    expect((await taskOf(a!.id)).error).toMatch(/^invalid_config/)
  })
})
