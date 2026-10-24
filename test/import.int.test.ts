import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { DomainError } from '../server/domain/errors'
import { importCandidates } from '../server/domain/import'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { type EngineDeps, type Enqueued, startApplication } from '../server/engine/engine'
import { testDb } from './db'

let db: Db
let jobId: string
const queue: Enqueued[] = []
const deps = (): EngineDeps => ({ db, handlers: {}, adminEmail: 'admin@example.test', enqueue: async (items) => { queue.push(...items) } })
const person = (email: string, extra: Record<string, unknown> = {}) => ({ first_name: 'Ann', last_name: 'Lee', email, ...extra })

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
  const { job } = await createJob(db, 'owner', { title: 'Engineer', description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, job.id, STANDARD_HIRE)
  await publish(db, job.id, 'admin@example.test')
  jobId = job.id
  // already applied to this job
  const [c] = await db.insert(s.candidates).values({ email: 'old@example.test', firstName: 'Old', lastName: 'Timer' }).returning()
  const [v] = await db.select().from(s.jobVersions).where(eq(s.jobVersions.jobId, jobId))
  await db.insert(s.applications).values({ jobId, candidateId: c!.id, jobVersionId: v!.id })
})
afterAll(() => db.close())

describe('import', () => {
  it('dry run counts new, duplicate and invalid rows with spreadsheet row numbers', async () => {
    const rows = [
      person('New@Example.test', { answers: { notice_period_weeks: '4' } }), // row 2
      person('old@example.test'), // 3: applied already
      { first_name: '', last_name: '', email: '' }, // 4: blank, skipped
      person('not-an-email'), // 5
      person('x@example.test', { last_name: '' }), // 6
      person('y@example.test', { answers: { notice_period_weeks: 'soon' } }), // 7
      person('new@example.test'), // 8: repeat of row 2
      person('z@example.test', { answers: { cv: 'cv.pdf' } }), // 9
      person('w@example.test', { start: 'nope' }), // 10
    ]
    const r = await importCandidates(db, jobId, rows, 'manual_review', 'owner', true)
    expect(r).toMatchObject({ create: 1, duplicates: ['old@example.test'], ids: [] })
    expect(r.invalid.map(i => i.row)).toEqual([5, 6, 7, 8, 9, 10])
    expect(r.invalid.find(i => i.row === 6)!.problem).toBe('last_name: missing')
    expect(r.invalid.find(i => i.row === 8)!.problem).toBe('email: same as row 2')
    expect(await db.select().from(s.candidates).where(eq(s.candidates.email, 'new@example.test'))).toEqual([])
    await expect(importCandidates(db, jobId, rows, 'nope', 'owner', true)).rejects.toBeInstanceOf(DomainError)
  })

  it('creates applications at the chosen step, source import, no consent, earlier steps not run; reuses candidates', async () => {
    await db.insert(s.candidates).values({ email: 'known@example.test', firstName: 'Kept', lastName: 'Name' })
    const r = await importCandidates(db, jobId, [
      person('known@example.test', { note: 'From the fair' }),
      person('fresh@example.test', { start: 'interview' }),
      person('trigger@example.test'),
    ], 'manual_review', 'owner', false)
    expect(r).toMatchObject({ create: 3, duplicates: [], invalid: [] })
    expect(r.ids).toHaveLength(3)

    // the third row starts from the flow's start like a real application
    const r2 = await importCandidates(db, jobId, [person('flow@example.test')], null, 'owner', false)
    for (const id of [...r.ids, ...r2.ids]) await startApplication(deps(), id)

    const apps = await db.select({ a: s.applications, email: s.candidates.email, first: s.candidates.firstName })
      .from(s.applications).innerJoin(s.candidates, eq(s.candidates.id, s.applications.candidateId)).where(eq(s.applications.jobId, jobId))
    const at = (email: string) => apps.find(x => x.email === email)!
    expect(at('known@example.test').first).toBe('Kept') // details never overwritten
    expect(at('known@example.test').a).toMatchObject({ source: 'import', consent: null, currentNodeKey: 'manual_review', status: 'active' })
    expect(at('fresh@example.test').a.currentNodeKey).toBe('interview')
    expect(at('flow@example.test').a.currentNodeKey).toBe('cv') // walked from the trigger, CV queued

    const known = at('known@example.test').a.id
    const runs = await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, known))
    expect(runs.map(x => [x.nodeKey, x.status])).toEqual([['manual_review', 'waiting_on_human']])
    const events = await db.select().from(s.applicationEvents).where(eq(s.applicationEvents.applicationId, known)).orderBy(s.applicationEvents.seq)
    expect(events.map(e => e.type)).toEqual(['imported', 'task_assigned'])
    expect(events[0]).toMatchObject({ actorId: 'owner', data: { node: 'manual_review', note: 'From the fair' } })

    // importing the same file again creates nothing
    const again = await importCandidates(db, jobId, [person('known@example.test')], null, 'owner', false)
    expect(again).toMatchObject({ create: 0, duplicates: ['known@example.test'], ids: [] })
  })
})
