import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import {
  type AutoHandler, type EngineDeps, type Enqueued, executeAutoRun, HandlerError, moveApplication, reassignTask,
  retryRun, startApplication, submitTask, sweep,
} from '../server/engine/engine'
import { testDb } from './db'

// Engine cases from backend_plan.md §6.4, numbered as there. Fake handlers stand in for CV/AI/email.

const ADMIN = 'admin@example.test'
let db: Db
let role: string
let t: Date
let queue: Enqueued[]
let sent: Map<string, string> // email idempotency key (runId) → node
let ai: () => Promise<Record<string, unknown>>
let enqueueFails = false

const handlers: Record<string, AutoHandler> = {
  cv_parse: async () => ({ output: { text: 'Senior engineer', skills: ['TypeScript'], years_experience: 6, current_title: 'Engineer', file_sha256: 'x' } }),
  ai_review: async () => ({ output: await ai() }),
  send_email: async ({ run }) => {
    if (!sent.has(run.id)) sent.set(run.id, run.nodeKey) // provider dedupes by idempotency key
    return { output: { sent: true } }
  },
}
const deps = (extra: Partial<EngineDeps> = {}): EngineDeps => ({
  db,
  handlers,
  adminEmail: ADMIN,
  now: () => t,
  enqueue: async (items) => {
    if (enqueueFails) throw new Error('queue down')
    queue.push(...items)
  },
  ...extra,
})
const advance = (ms: number) => { t = new Date(t.getTime() + ms) }

// Runs queued messages like the consumer would, honouring retry delays by moving the clock.
async function drain(d = deps()) {
  const results: string[] = []
  for (let i = 0; queue.length && i < 50; i++) {
    const item = queue.shift()!
    if (item.delaySeconds) advance(item.delaySeconds * 1000)
    results.push(await executeAutoRun(d, item.runId))
  }
  return results
}

const runs = (appId: string) => db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, appId)).orderBy(s.nodeRuns.seq)
const latest = async (appId: string, nodeKey?: string) => {
  const [r] = await db.select().from(s.nodeRuns)
    .where(nodeKey ? and(eq(s.nodeRuns.applicationId, appId), eq(s.nodeRuns.nodeKey, nodeKey)) : eq(s.nodeRuns.applicationId, appId))
    .orderBy(desc(s.nodeRuns.seq)).limit(1)
  return r!
}
const app = async (id: string) => (await db.query.applications.findFirst({ where: eq(s.applications.id, id) }))!
const events = async (id: string) => (await db.select().from(s.applicationEvents).where(eq(s.applicationEvents.applicationId, id)).orderBy(s.applicationEvents.seq)).map(e => e.type)
const rejects = async (p: Promise<unknown>, status: number, message?: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect((e as DomainError).status).toBe(status)
  if (message) expect((e as DomainError).message).toBe(message)
}

let seq = 0
async function publishedJob(mutate?: (t: typeof STANDARD_HIRE) => void) {
  const tpl = structuredClone(STANDARD_HIRE)
  mutate?.(tpl)
  const { job } = await createJob(db, 'owner', { title: 'Engineer', description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, job.id, tpl)
  await publish(db, job.id, ADMIN)
  return (await db.query.jobs.findFirst({ where: eq(s.jobs.id, job.id) }))!
}
async function apply(job: typeof s.jobs.$inferSelect) {
  const [c] = await db.insert(s.candidates).values({ email: `c${++seq}@example.test`, firstName: 'Jane', lastName: 'Doe' }).returning()
  const [a] = await db.insert(s.applications).values({
    jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!,
    answers: { cv: { key: 'k', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' } },
  }).returning()
  await startApplication(deps(), a!.id)
  return a!.id
}
const interview = (score: { technical: number, communication: number, hire: boolean }) => score

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  ;[{ id: role }] = await db.insert(s.roles).values({ name: 'Interviewer', level: 'employee' }).returning() as any
  await db.insert(s.user).values([
    { id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id },
    { id: 'i1', email: 'i1@example.test', name: 'I1', roleId: role },
    { id: 'i2', email: 'i2@example.test', name: 'I2', roleId: role },
    { id: 'outsider', email: 'out@example.test', name: 'Out', roleId: role },
  ])
})
afterAll(() => db.close())
beforeEach(() => {
  t = new Date('2026-10-20T09:00:00Z')
  queue = []
  sent = new Map()
  ai = async () => ({ skills_match: 90, experience: 80, overall: 85, summary: 'Strong' })
  enqueueFails = false
})

describe('normal flow', () => {
  it('1. happy path: CV → AI → shortlist → interview → hire → offer email → End(hired)', async () => {
    const job = await publishedJob()
    const id = await apply(job)
    expect((await latest(id)).nodeKey).toBe('cv') // trigger completed in the start transaction
    expect(await drain()).toEqual(['completed', 'completed']) // cv, ai
    const task = await latest(id)
    expect(task).toMatchObject({ nodeKey: 'interview', status: 'waiting_on_human' })
    expect(task.input).toEqual({ title: 'Interview Jane Doe' })

    await submitTask(deps(), task.id, 'owner', interview({ technical: 4, communication: 5, hire: true }))
    expect(await drain()).toEqual(['completed']) // offer email
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'hired', currentNodeKey: 'hired' })
    expect([...sent.values()]).toEqual(['offer_email'])
    expect((await runs(id)).map(r => r.nodeKey)).toEqual(['start', 'cv', 'ai', 'screen', 'interview', 'decision', 'offer_email', 'hired'])
    expect(await events(id)).toEqual(['application_submitted', 'task_assigned', 'task_submitted', 'closed'])
  })

  it('2. low AI score rejects, and the stored evaluation explains why', async () => {
    ai = async () => ({ skills_match: 10, experience: 30, overall: 20, summary: 'Weak' })
    const id = await apply(await publishedJob())
    await drain()
    await drain()
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'rejected' })
    const screen = await latest(id, 'screen')
    expect(screen.branchTaken).toBe('reject')
    expect((screen.evaluation as any).branches).toEqual([
      { key: 'shortlist', result: false, trace: [expect.objectContaining({ ref: 'nodes.ai.overall', op: 'gte', expected: 70, actual: 20 })] },
      { key: 'reject', result: true, trace: [expect.objectContaining({ op: 'lt', expected: 40, actual: 20 })] },
    ])
    expect([...sent.values()]).toEqual(['rejection_email'])
  })

  it('handler outputs are stored as their declared types (LLM JSON returns "85")', async () => {
    ai = async () => ({ skills_match: '90', experience: '80', overall: '85', summary: 'Strong' })
    const id = await apply(await publishedJob())
    await drain()
    expect((await latest(id, 'ai')).output).toMatchObject({ overall: 85 })
    expect(await latest(id, 'screen')).toMatchObject({ branchTaken: 'shortlist' })
  })

  it('3. missing AI score goes to manual review', async () => {
    ai = async () => ({ summary: 'no score' })
    const id = await apply(await publishedJob())
    await drain()
    expect(await latest(id, 'screen')).toMatchObject({ branchTaken: 'missing' })
    expect(await latest(id)).toMatchObject({ nodeKey: 'manual_review', status: 'waiting_on_human' })
  })

  it('4. borderline score takes the default branch to manual review, which can advance', async () => {
    ai = async () => ({ skills_match: 50, experience: 60, overall: 55, summary: 'Ok' })
    const id = await apply(await publishedJob())
    await drain()
    const review = await latest(id)
    expect(review.nodeKey).toBe('manual_review')
    await submitTask(deps(), review.id, 'owner', { advance: true })
    expect(await latest(id)).toMatchObject({ nodeKey: 'interview', status: 'waiting_on_human' })
  })
})

describe('delivery and concurrency', () => {
  it('6. a duplicate message is a no-op', async () => {
    const id = await apply(await publishedJob())
    const cv = await latest(id)
    expect(await executeAutoRun(deps(), cv.id)).toBe('completed')
    expect(await executeAutoRun(deps(), cv.id)).toBe('noop')
  })

  it('[race] 7. two consumers claiming the same run: exactly one wins', async () => {
    const id = await apply(await publishedJob())
    const cv = await latest(id)
    const results = await Promise.all([executeAutoRun(deps(), cv.id), executeAutoRun(deps(), cv.id)])
    expect(results.sort()).toEqual(['completed', 'noop'])
    expect((await runs(id)).filter(r => r.nodeKey === 'ai')).toHaveLength(1)
  })

  it('9. enqueue fails after commit: the sweeper re-sends', async () => {
    const job = await publishedJob()
    enqueueFails = true
    const id = await apply(job)
    enqueueFails = false
    expect(queue).toHaveLength(0)
    expect((await sweep(deps())).requeued).toBe(0) // too fresh to be lost
    advance(3 * 60_000)
    expect((await sweep(deps())).requeued).toBeGreaterThanOrEqual(1)
    await drain()
    expect((await latest(id)).nodeKey).toBe('interview')
  })

  it('[race] 10. a dead worker is recovered by the sweeper; its late write is fenced off', async () => {
    const id = await apply(await publishedJob())
    const cv = await latest(id)
    let release!: () => void
    const stuck = new Promise<void>(r => (release = r))
    const slow = deps({ handlers: { ...handlers, cv_parse: async (a) => { await stuck; return handlers.cv_parse!(a) } } })
    const first = executeAutoRun(slow, cv.id) // claims, then hangs in the handler
    queue = [] // that message is being handled by `first`
    await new Promise(r => setTimeout(r, 50))
    expect((await latest(id, 'cv')).status).toBe('running')

    advance(16 * 60_000)
    expect((await sweep(deps())).recovered).toBe(1)
    expect(await latest(id, 'cv')).toMatchObject({ status: 'pending', retries: 1, error: 'worker_lost' })
    await drain() // retried cv (after backoff), ai — plus anything other tests left pending, which the sweeper rightly re-sent
    expect((await runs(id)).filter(r => r.nodeKey === 'cv').map(r => [r.attempt, r.status, r.retries])).toEqual([[1, 'completed', 1]])
    expect((await latest(id)).nodeKey).toBe('interview')

    release()
    expect(await first).toBe('stale')
    expect((await runs(id)).filter(r => r.nodeKey === 'ai')).toHaveLength(1)
  })

  it('[race] 11. the database refuses a second active run for one application', async () => {
    const id = await apply(await publishedJob())
    const err = await db.insert(s.nodeRuns).values({ applicationId: id, nodeKey: 'ai', nodeType: 'ai_review', attempt: 9, status: 'pending' })
      .then(() => null, (e: any) => e)
    expect(err?.code ?? err?.cause?.code).toBe('23505')
  })
})

describe('failures', () => {
  it('12. retryable errors back off 3 times, then fail and log an event', async () => {
    ai = async () => { throw new Error('provider 503') }
    const id = await apply(await publishedJob())
    expect(await drain()).toEqual(['completed', 'retrying', 'retrying', 'retrying', 'failed'])
    expect(await latest(id)).toMatchObject({ nodeKey: 'ai', status: 'failed', retries: 3 })
    expect(await events(id)).toContain('run_failed')
    expect((await app(id)).status).toBe('active') // stalled, shows in the inbox
  })

  it('13. a non-retryable error fails at once', async () => {
    ai = async () => { throw new HandlerError('unreadable_cv', false) }
    const id = await apply(await publishedJob())
    expect(await drain()).toEqual(['completed', 'failed'])
    expect((await latest(id)).error).toBe('unreadable_cv')
  })

  it('14. kill switch fails the run as disabled; after re-enabling, retry continues the flow', async () => {
    const id = await apply(await publishedJob())
    const off = deps({ disabledTypes: new Set(['ai_review']) })
    expect(await drain(off)).toEqual(['completed', 'failed'])
    const failed = await latest(id)
    expect(failed).toMatchObject({ nodeKey: 'ai', error: 'disabled' })
    await retryRun(deps(), failed.id, 'owner')
    expect(await drain()).toEqual(['completed'])
    expect((await latest(id)).nodeKey).toBe('interview')
    expect((await runs(id)).filter(r => r.nodeKey === 'ai').map(r => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'completed']])
  })
})

describe('human tasks', () => {
  const panel = () => publishedJob((tpl) => {
    const n = tpl.workflow.nodes.find(n => n.key === 'interview')!
    n.config = { ...(n.config as object), assignees: { users: [], roles: [role], job_owner: false }, min_submissions: 2 }
  })

  it('19/20/26. panel of 2 from a role of 3: two submit, the third is closed out; doubles and outsiders refused', async () => {
    const id = await apply(await panel())
    await drain()
    const task = await latest(id)
    const assigned = await db.select().from(s.taskAssignments).where(eq(s.taskAssignments.runId, task.id))
    expect(assigned.map(a => a.userId).sort()).toEqual(['i1', 'i2', 'outsider'])

    expect(await submitTask(deps(), task.id, 'i1', { technical: 4, communication: 3, hire: true })).toEqual({ completed: false })
    await rejects(submitTask(deps(), task.id, 'i1', { technical: 1, communication: 1, hire: false }), 409, 'already_submitted')
    await rejects(submitTask(deps(), task.id, 'owner', { technical: 1, communication: 1, hire: false }), 404, 'task_not_found')
    await rejects(submitTask(deps(), task.id, 'i2', { technical: 9, communication: 3, hire: true }), 422, 'invalid_scorecard')
    expect(await submitTask(deps(), task.id, 'i2', { technical: 2, communication: 5, hire: false })).toEqual({ completed: true })
    await rejects(submitTask(deps(), task.id, 'outsider', { technical: 5, communication: 5, hire: true }), 409, 'task_closed')

    expect((await latest(id, 'interview')).output).toEqual({ submitted_count: 2, technical: 3, communication: 4, hire: false, hire_any: true })
    expect(await latest(id, 'decision')).toMatchObject({ branchTaken: 'default' }) // not everyone said hire
  })

  it('21. nobody resolvable at activation fails the task with no_assignees', async () => {
    const job = await publishedJob()
    await db.update(s.user).set({ active: false }).where(eq(s.user.id, 'owner'))
    try {
      const id = await apply(job)
      await drain()
      expect(await latest(id)).toMatchObject({ nodeKey: 'interview', status: 'failed', error: 'no_assignees' })
    }
    finally {
      await db.update(s.user).set({ active: true }).where(eq(s.user.id, 'owner'))
    }
  })

  it('23. reassign: add and remove keep submissions', async () => {
    const id = await apply(await panel())
    await drain()
    const task = await latest(id)
    await submitTask(deps(), task.id, 'i1', { technical: 4, communication: 3, hire: true })
    await reassignTask(deps(), task.id, { add: ['owner'], remove: ['i1', 'outsider'] }, 'owner')
    const rows = await db.select().from(s.taskAssignments).where(eq(s.taskAssignments.runId, task.id))
    const by = Object.fromEntries(rows.map(r => [r.userId, r]))
    expect(by.i1!.submittedAt).not.toBeNull() // submitted, so not removed
    expect(by.i1!.closedAt).toBeNull()
    expect(by.outsider!.closedAt).not.toBeNull()
    await rejects(submitTask(deps(), task.id, 'outsider', { technical: 5, communication: 5, hire: true }), 409, 'task_closed')
    expect(await submitTask(deps(), task.id, 'owner', { technical: 4, communication: 4, hire: true })).toEqual({ completed: true })
    await rejects(reassignTask(deps(), task.id, { add: ['ghost'], remove: [] }, 'owner'), 409, 'task_closed')
  })

  it('24. due date comes from due_days', async () => {
    const id = await apply(await publishedJob())
    await drain()
    expect((await latest(id)).dueAt).toEqual(new Date(t.getTime() + 5 * 86_400_000))
  })
})

describe('manual control', () => {
  it('28/30. move to a later node during a human task; refs to skipped nodes resolve as missing', async () => {
    const id = await apply(await publishedJob())
    await drain()
    const task = await latest(id)
    await moveApplication(deps(), id, { node: 'decision' }, 'skip interview', 'owner')
    expect(await latest(id, 'interview')).toMatchObject({ status: 'cancelled' })
    await rejects(submitTask(deps(), task.id, 'owner', { technical: 4, communication: 4, hire: true }), 409, 'task_closed')
    // decision has no on_missing branch, so missing interview data falls to default → rejection email
    expect(await latest(id, 'decision')).toMatchObject({ branchTaken: 'default' })
    const ev = (await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, id), eq(s.applicationEvents.type, 'manual_move'))))[0]!
    expect(ev).toMatchObject({ actorId: 'owner', data: expect.objectContaining({ reason: 'skip interview', previous: expect.objectContaining({ node: 'interview' }) }) })
  })

  it('[race] 29. move while an auto run is running: the run is cancelled and its completion is dropped', async () => {
    const id = await apply(await publishedJob())
    const cv = await latest(id)
    let release!: () => void
    const stuck = new Promise<void>(r => (release = r))
    const slow = deps({ handlers: { ...handlers, cv_parse: async (a) => { await stuck; return handlers.cv_parse!(a) } } })
    const pending = executeAutoRun(slow, cv.id)
    await new Promise(r => setTimeout(r, 50))
    await moveApplication(deps(), id, { close: 'withdrawn' }, 'candidate withdrew', 'owner')
    release()
    expect(await pending).toBe('stale')
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'withdrawn' })
    expect((await runs(id)).some(r => r.nodeKey === 'ai')).toBe(false)
  })

  it('31/32. close directly, then reopen into review (appeal)', async () => {
    const id = await apply(await publishedJob())
    await moveApplication(deps(), id, { close: 'rejected' }, 'not a fit', 'owner')
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'rejected' })
    expect(await executeAutoRun(deps(), (await latest(id, 'cv')).id)).toBe('noop') // cv was cancelled by the move

    await moveApplication(deps(), id, { node: 'manual_review' }, 'appeal', 'owner')
    expect(await app(id)).toMatchObject({ status: 'active', outcome: null })
    expect(await latest(id)).toMatchObject({ nodeKey: 'manual_review', status: 'waiting_on_human' })
    expect(await events(id)).toEqual(expect.arrayContaining(['manual_move', 'closed', 'reopened', 'task_assigned']))
  })

  it('33. retry only the latest failed run', async () => {
    ai = async () => { throw new HandlerError('bad', false) }
    const id = await apply(await publishedJob())
    await drain()
    const failed = await latest(id)
    await rejects(retryRun(deps(), (await latest(id, 'cv')).id, 'owner'), 409, 'not_latest_run')
    await moveApplication(deps(), id, { node: 'manual_review' }, 'manual', 'owner')
    await rejects(retryRun(deps(), failed.id, 'owner'), 409, 'not_latest_run')
    await rejects(retryRun(deps(), (await latest(id)).id, 'owner'), 409, 'not_retryable')
  })

  it('33b. a run stuck in running for 15+ minutes can be retried by hand', async () => {
    const id = await apply(await publishedJob())
    const cv = await latest(id)
    await db.update(s.nodeRuns).set({ status: 'running', claimedAt: t }).where(eq(s.nodeRuns.id, cv.id))
    await rejects(retryRun(deps(), cv.id, 'owner'), 409, 'not_retryable')
    advance(16 * 60_000)
    await retryRun(deps(), cv.id, 'owner')
    expect((await runs(id)).filter(r => r.nodeKey === 'cv').map(r => [r.attempt, r.status, r.error])).toEqual([[1, 'failed', 'stale_running'], [2, 'pending', null]])
  })

  it('34. the move target must exist in the pinned version', async () => {
    const id = await apply(await publishedJob())
    await rejects(moveApplication(deps(), id, { node: 'nope' }, 'x', 'owner'), 422, 'node_not_in_version')
    expect((await latest(id)).status).toBe('pending') // nothing changed
  })
})

describe('versions', () => {
  it('35. publishing v2 leaves in-flight applications on v1', async () => {
    const job = await publishedJob()
    const id = await apply(job)
    const v2 = structuredClone(STANDARD_HIRE)
    v2.workflow.nodes = v2.workflow.nodes.map(n => n.key === 'screen'
      ? { ...n, config: { ...(n.config as any), branches: [{ key: 'shortlist', label: 'S', rule: { ref: 'nodes.ai.overall', op: 'gte', value: 100 } }, (n.config as any).branches[1]] } }
      : n)
    await saveDraft(db, job.id, v2)
    await publish(db, job.id, ADMIN)
    await drain()
    expect(await latest(id, 'screen')).toMatchObject({ branchTaken: 'shortlist' }) // v1 rules
  })
})
