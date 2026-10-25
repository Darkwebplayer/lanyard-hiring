import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Graph } from '../shared/workflow/types'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { board, movable, pipeline } from '../server/domain/applications'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { getSettings, settingsInput } from '../server/domain/settings'
import { type AutoHandler, checkMove, type EngineDeps, type Enqueued, executeAutoRun, moveApplication, startApplication } from '../server/engine/engine'
import { testDb } from './db'

// SMB release: board cards (30 per step, score, source, since), list filters, move reasons and asks, settings.

const ADMIN = 'admin@example.test'
let db: Db
let queue: Enqueued[]
let overall: number
const handlers: Record<string, AutoHandler> = {
  cv_parse: async () => ({ output: { text: 'x', skills: [], years_experience: 3, current_title: 'Dev', file_sha256: 'x' } }),
  ai_review: async () => ({ output: { skills_match: overall, experience: overall, overall, summary: 'ok' } }),
  send_email: async () => ({ output: { sent: true } }),
}
const deps = (): EngineDeps => ({ db, handlers, adminEmail: ADMIN, enqueue: async (i) => { queue.push(...i) } })
const drain = async () => { while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId) }
const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}

let n = 0
async function makeJob() {
  const tpl = structuredClone(STANDARD_HIRE)
  tpl.workflow.nodes.find(x => x.key === 'interview')!.config = { ...(tpl.workflow.nodes.find(x => x.key === 'interview')!.config as object), assignees: { users: ['owner'], roles: [], job_owner: false } }
  tpl.workflow.stages!.find(st => st.id === 'interview')!.ask = [{ key: 'when', label: 'Interview date', type: 'date', required: true }]
  const { job } = await createJob(db, 'owner', { title: `Job ${++n}`, description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, job.id, tpl)
  await publish(db, job.id, ADMIN)
  return (await db.query.jobs.findFirst({ where: eq(s.jobs.id, job.id) }))!
}
async function apply(job: typeof s.jobs.$inferSelect, source: string | null = null) {
  const [c] = await db.insert(s.candidates).values({ email: `c${++n}@example.test`, firstName: 'Jane', lastName: `Doe${n}` }).returning()
  const [a] = await db.insert(s.applications).values({
    jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!, source,
    answers: { cv: { key: `k${n}`, sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' } },
  }).returning()
  await startApplication(deps(), a!.id)
  await drain()
  return a!.id
}
const moveEvent = async (id: string) => (await db.select().from(s.applicationEvents)
  .where(and(eq(s.applicationEvents.applicationId, id), eq(s.applicationEvents.type, 'manual_move'))))[0]!.data

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
})
afterAll(() => db.close())
beforeEach(() => {
  queue = []
  overall = 85
})

describe('board and list', () => {
  it('shows up to 30 people per step with score, source and since; the list filters by score and source', async () => {
    const job = await makeJob()
    for (let i = 0; i < 31; i++) await apply(job, i === 0 ? 'linkedin' : null)
    overall = 50 // lands in manual review
    const low = await apply(job, 'indeed')

    const bd = await board(db, job.id)
    expect(bd.counts.find(c => c.key === 'interview')).toMatchObject({ n: 31 })
    const atInterview = bd.preview.filter(r => r.currentNodeKey === 'interview')
    expect(atInterview.length).toBe(30)
    expect(atInterview[0]).toMatchObject({ score: 85 })
    expect(Number.isNaN(new Date(atInterview[0]!.since).getTime())).toBe(false)
    expect(bd.preview.find(r => r.id === low)).toMatchObject({ score: 50, source: 'indeed', currentNodeKey: 'manual_review' })

    expect((await pipeline(db, job.id, { maxScore: 60 })).map(r => r.id)).toEqual([low])
    expect((await pipeline(db, job.id, { minScore: 60, limit: 1 }))[0]!.total).toBe(31)
    expect((await pipeline(db, job.id, { minScore: 90 }))).toEqual([])
    expect((await pipeline(db, job.id, { source: 'linkedin' })).map(r => r.source)).toEqual(['linkedin'])
    expect((await pipeline(db, job.id, { source: 'none', limit: 1 }))[0]!.total).toBe(30)
  })

  it('counts closed people by outcome, whatever step they closed on', async () => {
    const job = await makeJob()
    const [a, b] = [await apply(job), await apply(job)]
    // an end-step hire sits on 'hired'; an accepted offer closes them where they were
    await db.update(s.applications).set({ status: 'closed', outcome: 'hired', currentNodeKey: 'hired' }).where(eq(s.applications.id, a))
    await db.update(s.applications).set({ status: 'closed', outcome: 'hired' }).where(eq(s.applications.id, b))
    const bd = await board(db, job.id)
    expect(bd.counts.filter(c => c.outcome === 'hired')).toMatchObject([{ key: null, n: 2 }])
  })
})

describe('moves', () => {
  it('rejecting needs a listed reason code; asks are validated and stored; old events keep renamed reasons', async () => {
    const job = await makeJob()
    overall = 50
    const id = await apply(job)

    await rejects(moveApplication(deps(), id, { close: 'rejected' }, { reason: 'meh' }, 'owner'), 422, 'reason_code_required')
    await rejects(moveApplication(deps(), id, { close: 'rejected' }, { reasonCode: 'Nope' }, 'owner'), 422, 'unknown_reason_code')
    // a node move may carry a reason code (a step that ends in a rejection), but only a listed one
    await rejects(moveApplication(deps(), id, { node: 'cv' }, { reason: 'x', reasonCode: 'Nope' }, 'owner'), 422, 'unknown_reason_code')
    // a jump the flow doesn't take still needs a reason
    await rejects(moveApplication(deps(), id, { node: 'cv' }, {}, 'owner'), 422, 'reason_required')
    // the Interview stage asks for a date
    await rejects(moveApplication(deps(), id, { node: 'interview' }, { reason: 'good' }, 'owner'), 422, 'invalid_answers')
    await rejects(moveApplication(deps(), id, { node: 'interview' }, { reason: 'good', answers: { when: 'soon' } }, 'owner'), 422, 'invalid_answers')
    await moveApplication(deps(), id, { node: 'interview' }, { reason: 'good', answers: { when: '2026-11-02', extra: 1 } }, 'owner')
    expect(await moveEvent(id)).toMatchObject({ reason: 'good', answers: { when: '2026-11-02' } })
    expect((await moveEvent(id) as any).answers.extra).toBeUndefined()

    const other = await apply(job)
    await moveApplication(deps(), other, { close: 'rejected' }, { reasonCode: 'Position filled' }, 'owner')
    expect(await moveEvent(other)).toMatchObject({ reason: null, reasonCode: 'Position filled' })
    await db.insert(s.settings).values({ id: 1, rejectReasons: ['Role filled'] })
      .onConflictDoUpdate({ target: s.settings.id, set: { rejectReasons: ['Role filled'] } })
    expect(await moveEvent(other)).toMatchObject({ reasonCode: 'Position filled' })
    const third = await apply(job)
    await rejects(moveApplication(deps(), third, { close: 'rejected' }, { reasonCode: 'Position filled' }, 'owner'), 422, 'unknown_reason_code')
    await moveApplication(deps(), third, { close: 'rejected' }, { reasonCode: 'Role filled', reason: 'took an internal' }, 'owner')

    // a group move is checked against each pinned flow before anything is sent
    await apply(job)
    const found = await movable(db, job.id, { node: 'manual_review' }, { node: 'interview' })
    expect(found.graphs.length).toBe(1)
    expect(() => checkMove(found.graphs[0]!, { node: 'manual_review' }, { node: 'interview' }, { reason: 'x' }, [])).toThrow('invalid_answers')
  })

  it('a move along the flow needs no reason; skips and backs do', () => {
    const task = (key: string) => ({ key, type: 'human_task', config: {} })
    const g: Graph = { nodes: [task('a'), task('b'), task('c')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }
    expect(checkMove(g, { node: 'a' }, { node: 'b' }, {}, [])).toEqual({ reason: null })
    expect(() => checkMove(g, { node: 'a' }, { node: 'c' }, {}, [])).toThrow('reason_required')
    expect(() => checkMove(g, { node: 'c' }, { node: 'a' }, {}, [])).toThrow('reason_required')
    expect(() => checkMove(g, null, { node: 'a' }, {}, [])).toThrow('reason_required')
  })
})

describe('settings', () => {
  it('defaults before anyone saved, and validates careers intro and reject reasons', async () => {
    const fresh = await testDb()
    expect((await getSettings(fresh)).rejectReasons).toContain('Position filled')
    await fresh.close()
    const base = { companyName: null, replyToEmail: null, consentText: null, aiNoticeText: null }
    expect(settingsInput.parse({ ...base, rejectReasons: [' Too far ', 'Other'] }).rejectReasons).toEqual(['Too far', 'Other'])
    expect(settingsInput.safeParse(base).success).toBe(true) // older clients leave them out
    expect(settingsInput.safeParse({ ...base, rejectReasons: [] }).success).toBe(false)
    expect(settingsInput.safeParse({ ...base, rejectReasons: ['A', ' A'] }).success).toBe(false)
    expect(settingsInput.safeParse({ ...base, rejectReasons: ['x'.repeat(61)] }).success).toBe(false)
    expect(settingsInput.safeParse({ ...base, rejectReasons: Array.from({ length: 21 }, (_, i) => `r${i}`) }).success).toBe(false)
    expect(settingsInput.safeParse({ ...base, careersIntro: 'x'.repeat(501) }).success).toBe(false)
  })
})
