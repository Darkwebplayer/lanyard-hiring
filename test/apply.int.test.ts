import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { publicJob, submitApplication, type Submission } from '../server/domain/apply'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft, updateJob } from '../server/domain/jobs'
import { verifyTurnstile } from '../server/domain/turnstile'
import { type Enqueued, startApplication, sweep } from '../server/engine/engine'
import { testDb } from './db'

const pdf = new Uint8Array(readFileSync(new URL('./fixtures/cv.pdf', import.meta.url)))
const docx = new Uint8Array(readFileSync(new URL('./fixtures/cv.docx', import.meta.url)))
const now = new Date('2026-10-20T09:00:00Z')

let db: Db
let jobId: string
let bucket: Map<string, Uint8Array>
const fakeBucket = {
  put: async (k: string, v: Uint8Array) => { bucket.set(k, v) },
  delete: async (k: string) => { bucket.delete(k) },
}
let n = 0
const sub = (over: Partial<Submission['fields']> = {}, files: Submission['files'] = { cv: { bytes: pdf, name: 'cv.pdf' } }): Submission => ({
  fields: { first_name: 'Jane', last_name: 'Doe', email: `Jane${++n}@Example.test`, notice_period_weeks: '4', ...over },
  files,
})
const fails = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
  return e as DomainError
}

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
  await db.update(s.settings).set({ consentText: 'We process your data to assess your application.', aiNoticeText: 'An AI helps screen applications.' })
  const { job } = await createJob(db, 'owner', { title: 'Backend Engineer', description: 'Build things', requirements: { location: 'Remote', salary_min: 1 }, openings: 1, closesAt: new Date('2026-11-01T00:00:00Z') }, { kind: 'blank' })
  await saveDraft(db, job.id, STANDARD_HIRE)
  await publish(db, job.id, 'admin@example.test')
  jobId = job.id
})
afterAll(() => db.close())
beforeEach(() => { bucket = new Map() })

describe('public job page', () => {
  it('shows only applicant-facing fields, with the consent and AI notices', async () => {
    const page = await publicJob(db, jobId, now)
    expect(page).toMatchObject({ title: 'Backend Engineer', location: 'Remote', consentText: expect.any(String), aiNoticeText: expect.any(String) })
    expect(page.form.map(f => f.key)).toEqual(['cv', 'linkedin', 'notice_period_weeks'])
    expect(JSON.stringify(page)).not.toContain('salary') // internal requirements stay internal
  })

  it('is gone after the closing date or when the job is closed', async () => {
    await fails(publicJob(db, jobId, new Date('2026-11-01T00:00:00Z')), 404, 'job_not_open')
    await updateJob(db, jobId, { status: 'closed' })
    await fails(publicJob(db, jobId, now), 404, 'job_not_open')
    await updateJob(db, jobId, { status: 'open' })
  })
})

describe('submit', () => {
  it('stores the CV write-once with its hash, saves answers, and the flow starts', async () => {
    const id = await submitApplication(db, fakeBucket, jobId, sub(), now)
    const app = (await db.query.applications.findFirst({ where: eq(s.applications.id, id) }))!
    const cv = (app.answers as any).cv
    expect(cv).toMatchObject({ mime: 'application/pdf', size: pdf.length, name: 'cv.pdf', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(cv.key).toMatch(new RegExp(`^jobs/${jobId}/${id}/[0-9a-f-]{36}$`))
    expect(bucket.get(cv.key)).toEqual(pdf)
    expect((app.answers as any).notice_period_weeks).toBe(4)
    const candidate = await db.query.candidates.findFirst({ where: eq(s.candidates.id, app.candidateId) })
    expect(candidate!.email).toBe(`jane${n}@example.test`) // lowercased

    const queue: Enqueued[] = []
    await startApplication({ db, handlers: {}, adminEmail: 'admin@example.test', enqueue: async i => { queue.push(...i) } }, id)
    expect(queue).toHaveLength(1) // cv_parse queued
  })

  it('accepts DOCX; refuses other files by their bytes, not their name', async () => {
    await submitApplication(db, fakeBucket, jobId, sub({}, { cv: { bytes: docx, name: 'cv.docx' } }), now)
    const fake = new TextEncoder().encode('MZ this is an exe')
    const e = await fails(submitApplication(db, fakeBucket, jobId, sub({}, { cv: { bytes: fake, name: 'cv.pdf' } }), now), 422, 'invalid_application')
    expect(e.issues!.map(i => i.message)).toEqual(['cv: only PDF or DOCX files are accepted'])
  })

  it('refuses files over 10 MB', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(pdf.subarray(0, 8))
    await fails(submitApplication(db, fakeBucket, jobId, sub({}, { cv: { bytes: big, name: 'cv.pdf' } }), now), 422, 'invalid_application')
  })

  it('invalid answers write nothing: no candidate, no application, no file', async () => {
    const before = (await db.select().from(s.candidates)).length
    const e = await fails(submitApplication(db, fakeBucket, jobId, sub({ email: 'not-an-email', notice_period_weeks: '99' }, {}), now), 422, 'invalid_application')
    expect(e.issues!.map(i => i.message.split(':')[0]).sort()).toEqual(['cv', 'email', 'notice_period_weeks'])
    expect((await db.select().from(s.candidates)).length).toBe(before)
    expect(bucket.size).toBe(0)
  })

  it('one application per candidate per job; the duplicate leaves no orphaned file', async () => {
    await submitApplication(db, fakeBucket, jobId, sub({ email: 'dup@example.test' }), now)
    bucket.clear()
    await fails(submitApplication(db, fakeBucket, jobId, sub({ email: 'DUP@example.test', first_name: 'J' }), now), 409, 'already_applied')
    expect(bucket.size).toBe(0)
  })

  it('the closing date is enforced at request time', async () => {
    await fails(submitApplication(db, fakeBucket, jobId, sub(), new Date('2026-11-02T00:00:00Z')), 404, 'job_not_open')
  })

  it('the sweeper starts an application whose apply request died after commit', async () => {
    const id = await submitApplication(db, fakeBucket, jobId, sub(), now)
    const queue: Enqueued[] = []
    const deps = { db, handlers: {}, adminEmail: 'admin@example.test', enqueue: async (i: Enqueued[]) => { queue.push(...i) }, now: () => new Date(Date.now() + 3 * 60_000) }
    const res = await sweep(deps)
    expect(res.started).toBeGreaterThanOrEqual(1)
    expect((await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, id)).orderBy(s.nodeRuns.seq)).map(r => r.nodeKey)).toEqual(['start', 'cv'])
  })
})

describe('turnstile', () => {
  const answer = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch
  it('fails closed', async () => {
    expect(await verifyTurnstile('s', 't', undefined, answer({ success: true }))).toBe(true)
    expect(await verifyTurnstile('s', 't', undefined, answer({ success: false }))).toBe(false)
    expect(await verifyTurnstile('s', 't', undefined, answer({}, false))).toBe(false)
    expect(await verifyTurnstile(undefined, 't', undefined, answer({ success: true }))).toBe(false)
    expect(await verifyTurnstile('s', undefined, undefined, answer({ success: true }))).toBe(false)
    expect(await verifyTurnstile('s', 't', undefined, (async () => { throw new Error('down') }) as typeof fetch)).toBe(false)
  })
})
