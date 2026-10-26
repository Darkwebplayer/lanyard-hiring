import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import type { Viewer } from '../server/domain/applications'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { listNotices, markNotice, markNotices } from '../server/domain/notices'
import { makeOffer, offerInput, respondToOffer } from '../server/domain/offers'
import { type AutoHandler, type EngineDeps, type Enqueued, executeAutoRun, HandlerError, moveApplication, passTask, reassignTask, retryRun, startApplication } from '../server/engine/engine'
import { testDb } from './db'

// The Updates tray: what counts, what is quiet, what never shows, and the seen / clear / dismiss markers.

const ADMIN = 'admin@example.test'
const TZ = 'Europe/London'
let db: Db
let role: string
let queue: Enqueued[]

let cvFails = false
const handlers: Record<string, AutoHandler> = {
  cv_parse: async () => {
    if (cvFails) throw new HandlerError('unreadable_cv', false)
    return { output: { text: 'Engineer', skills: ['TypeScript'], years_experience: 6, current_title: 'Engineer', file_sha256: 'x' } }
  },
  ai_review: async () => ({ output: { skills_match: 90, experience: 80, overall: 85, summary: 'Strong' } }),
  send_email: async () => ({ output: { sent: true } }),
}
const deps = (): EngineDeps => ({ db, handlers, adminEmail: ADMIN, now: () => new Date(), enqueue: async (i) => { queue.push(...i) } })
const drain = async () => { while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId) }

const owner: Viewer = { userId: 'owner', level: 'manager' }
const boss: Viewer = { userId: 'boss', level: 'manager' }
const emp = (userId: string): Viewer => ({ userId, level: 'employee' })
const list = (v: Viewer) => listNotices(db, v, TZ, new Date())
const about = async (v: Viewer, who: string) => (await list(v)).items.filter(i => i.text.includes(who))

let n = 0
async function panelJob() {
  const tpl = structuredClone(STANDARD_HIRE)
  const node = tpl.workflow.nodes.find(n => n.key === 'interview')!
  node.config = { ...(node.config as object), assignees: { users: [], roles: [role], job_owner: false }, min_submissions: 2 }
  const { job } = await createJob(db, 'owner', { title: `Engineer ${++n}`, description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, job.id, tpl)
  await publish(db, job.id, ADMIN)
  return (await db.query.jobs.findFirst({ where: eq(s.jobs.id, job.id) }))!
}
async function apply(job: typeof s.jobs.$inferSelect) {
  const [c] = await db.insert(s.candidates).values({ email: `c${++n}@example.test`, firstName: 'Jane', lastName: `Doe${n}` }).returning()
  const [a] = await db.insert(s.applications).values({
    jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!,
    answers: { cv: { key: `k${n}`, sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' } },
  }).returning()
  await startApplication(deps(), a!.id)
  await drain()
  return { id: a!.id, name: `Jane Doe${n}` }
}
const taskOf = async (appId: string) => (await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, appId)).orderBy(desc(s.nodeRuns.seq)).limit(1))[0]!

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  ;[{ id: role }] = await db.insert(s.roles).values({ name: 'Interviewer', level: 'employee' }).returning() as any
  await db.insert(s.user).values([
    { id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id },
    { id: 'boss', email: 'boss@example.test', name: 'Boss', roleId: manager!.id },
    { id: 'i1', email: 'i1@example.test', name: 'Ida', roleId: role },
    { id: 'i2', email: 'i2@example.test', name: 'Ivo', roleId: role },
    { id: 'i3', email: 'i3@example.test', name: 'Isa', roleId: role },
  ])
})
afterAll(() => db.close())
beforeEach(() => { queue = []; cvFails = false })

describe('notices', () => {
  it('a new application is a quiet line; the interviewers it reaches are told', async () => {
    const a = await apply(await panelJob())
    expect(await about(owner, a.name)).toEqual([expect.objectContaining({ tier: 'fyi', cat: 'candidates', text: `${a.name} applied for Engineer ${n - 1}`, to: `/candidates/${a.id}` })])
    expect(await about(emp('i1'), a.name)).toEqual([expect.objectContaining({ tier: 'important', text: `You have Interview for ${a.name}` })])
  })

  it('a pass counts only while it leaves the step short; a reassign settles it', async () => {
    const a = await apply(await panelJob())
    const run = await taskOf(a.id)
    await passTask(deps(), run.id, 'i1')
    expect(await about(owner, a.name)).toContainEqual(expect.objectContaining({ tier: 'fyi', text: `Ida passed on Interview for ${a.name}` }))
    await passTask(deps(), run.id, 'i2')
    expect(await about(owner, a.name)).toContainEqual(expect.objectContaining({
      tier: 'important', cat: 'problems', text: `Ivo passed on Interview for ${a.name}. It needs 1 more person.`, to: `/candidates/${a.id}#node:interview`,
    }))
    await reassignTask(deps(), run.id, { add: ['i2'], remove: [] }, 'owner')
    expect((await about(owner, a.name)).filter(i => i.tier !== 'fyi')).toEqual([])
    // the person who passed is not told about their own pass
    expect(await about(emp('i2'), a.name)).toEqual([expect.objectContaining({ text: `You have Interview for ${a.name}` }), expect.objectContaining({ text: `Owner gave you Interview for ${a.name}` })].reverse())
  })

  it('your own close never shows; others get one line for it, not its side effects', async () => {
    const a = await apply(await panelJob())
    const before = (await about(owner, a.name)).length
    await moveApplication(deps(), a.id, { close: 'rejected' }, { reasonCode: 'Other' }, 'owner')
    expect(await about(owner, a.name)).toHaveLength(before)
    expect((await about(boss, a.name)).filter(i => i.text.startsWith('Owner'))).toEqual([expect.objectContaining({ tier: 'fyi', text: `Owner closed ${a.name} as rejected` })])
  })

  it('an offer accepted on the link reaches the person who made it, as one counted line', async () => {
    const a = await apply(await panelJob())
    const o = await makeOffer(db, a.id, offerInput.parse({ templateId: null, terms: { salary: '£40,000', start_date: '2026-12-01' } }), 'owner', new Date())
    await respondToOffer(deps(), o.token, { action: 'accept', signedName: a.name })
    for (const v of [owner, boss]) {
      const items = (await about(v, a.name)).filter(i => i.cat === 'offers' || i.text.includes('hired'))
      expect(items.find(i => i.text === `${a.name} accepted the offer for Engineer ${n - 1}`)).toMatchObject({ tier: 'important', to: `/candidates/${a.id}#offer-h` })
      expect(items.filter(i => i.text.includes('hired'))).toEqual([]) // the close it caused is the same news
    }
  })

  it('a stopped step is red until someone retries it', async () => {
    cvFails = true
    const a = await apply(await panelJob())
    expect(await about(owner, a.name)).toContainEqual(expect.objectContaining({
      tier: 'urgent', cat: 'problems', text: `CV extraction couldn’t run for ${a.name}. The CV can’t be read.`, to: `/candidates/${a.id}#node:cv`,
    }))
    cvFails = false
    await retryRun(deps(), (await taskOf(a.id)).id, 'boss')
    await drain()
    expect((await about(owner, a.name)).find(i => i.cat === 'problems')).toMatchObject({ tier: 'fyi' })
  })

  it('applications to one job on one day are one line', async () => {
    const job = await panelJob()
    await apply(job)
    await apply(job)
    await apply(job)
    expect((await list(boss)).items.filter(i => i.text.endsWith(job.title))).toEqual([
      expect.objectContaining({ tier: 'fyi', text: `3 new applications for ${job.title}`, to: `/jobs/${job.id}?view=list` }),
    ])
  })

  it('seen zeroes the count, a click marks read, dismiss hides one, clear hides all', async () => {
    const a = await apply(await panelJob())
    await passTask(deps(), (await taskOf(a.id)).id, 'i1')
    await passTask(deps(), (await taskOf(a.id)).id, 'i2')
    const first = await list(boss)
    expect(first.unread).toBeGreaterThan(0)
    expect((await listNotices(db, boss, TZ, new Date(), true)).unread).toBe(first.unread)

    await markNotices(db, 'boss', { seen: first.latestSeq })
    expect((await listNotices(db, boss, TZ, new Date(), true)).unread).toBe(0)
    expect((await list(boss)).unread).toBe(0)

    const [top, next] = first.items
    await markNotice(db, 'boss', top!.seq, false)
    expect((await list(boss)).items[0]).toMatchObject({ seq: top!.seq, read: true })
    await markNotice(db, 'boss', top!.seq, true)
    await markNotice(db, 'boss', top!.seq, false) // a later click doesn't bring it back
    expect((await list(boss)).items[0]!.seq).toBe(next!.seq)

    await markNotices(db, 'boss', { cleared: first.latestSeq, seen: 0 }) // markers never move back
    expect((await list(boss)).items).toEqual([])
    expect(await db.select().from(s.noticeState).where(eq(s.noticeState.userId, 'boss'))).toEqual([{ userId: 'boss', seenSeq: first.latestSeq, clearedSeq: first.latestSeq }])
  })
})
