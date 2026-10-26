import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { submitApplication } from '../server/domain/apply'
import { deliver } from '../server/domain/emails'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { candidateSteps } from '../shared/workflow/stages'
import { publicStatus, requestStatusLink } from '../server/domain/status'
import { type EngineDeps, moveApplication } from '../server/engine/engine'
import { testDb } from './db'

const pdf = new Uint8Array(readFileSync(new URL('./fixtures/cv.pdf', import.meta.url)))
const NOW = new Date('2026-10-20T09:00:00Z')
const URL_ = 'https://hire.example.test'
const bucket = { put: async () => {}, delete: async () => {} }
let db: Db
let jobs: string[] = []
const deps = (): EngineDeps => ({ db, handlers: {}, adminEmail: 'admin@example.test', now: () => NOW, enqueue: async () => {}, appUrl: URL_ })
const sendAll = () => deliver(db, async () => {})
const apply = (jobId: string, email: string) => submitApplication(db, bucket, jobId,
  { fields: { first_name: 'Wei', last_name: 'Tan', email, notice_period_weeks: '2' }, files: { cv: { bytes: pdf, name: 'cv.pdf' } } }, NOW, URL_)
const tokenOf = async (email: string) => (await db.query.candidates.findFirst({ where: eq(s.candidates.email, email) }))!.statusToken
const status = async (email: string) => publicStatus(db, await tokenOf(email), NOW)

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
  await db.update(s.settings).set({ companyName: 'Kopi & Co' })
  for (const title of ['Barista', 'Shift Lead']) {
    const { job } = await createJob(db, 'owner', { title, description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
    // the interview asks them to book, so moving someone there sends an email
    const flow = structuredClone(STANDARD_HIRE)
    const iv = flow.workflow.nodes.find(n => n.key === 'interview')!
    iv.config = { ...(iv.config as object), booking: { duration_min: 30 } }
    await saveDraft(db, job.id, flow)
    await publish(db, job.id, 'admin@example.test')
    jobs.push(job.id)
  }
})
afterAll(() => db.close())

describe('candidate steps', () => {
  it('names stages for candidates, merges neighbours and leaves out a stage that only closes', () => {
    expect(candidateSteps(STANDARD_HIRE.workflow).steps).toEqual(['Applied', 'In review', 'Interview', 'Offer'])
  })
})

describe('status page', () => {
  it('one link for all their applications; the received email carries it and shows only once sent', async () => {
    const a = await apply(jobs[0]!, 'wei@example.test')
    await apply(jobs[1]!, 'wei@example.test')
    const token = await tokenOf('wei@example.test')
    const [mail] = await db.select().from(s.candidateEmails).where(eq(s.candidateEmails.applicationId, a))
    expect(mail).toMatchObject({ kind: 'received', subject: 'We got your application', nodeKey: null })
    expect(mail!.body).toContain(`Follow your applications with Kopi & Co:\n${URL_}/status/${token}`)

    let st = await status('wei@example.test')
    expect(st.applications.map(x => x.job)).toEqual(['Shift Lead', 'Barista'])
    expect(st.updates).toEqual([])
    await sendAll()
    st = await status('wei@example.test')
    expect(st.updates.map(u => u.subject)).toEqual(['We got your application', 'We got your application'])
    expect(st.applications[1]).toMatchObject({ step: 0, outcome: null })
    expect(JSON.stringify(st)).not.toContain('Screening') // internal names stay in
  })

  it('progress and the booking to do wait for the email', async () => {
    const id = await apply(jobs[0]!, 'mei@example.test')
    await sendAll()
    await moveApplication(deps(), id, { node: 'interview' }, { reason: 'strong CV' }, 'owner')
    let app = (await status('mei@example.test')).applications[0]!
    expect(app.step).toBe(0)
    expect((await status('mei@example.test')).todo).toEqual([])

    await sendAll()
    const st = await status('mei@example.test')
    app = st.applications[0]!
    expect(app.steps[app.step]).toBe('Interview')
    expect(st.todo).toMatchObject([{ kind: 'book', job: 'Barista', url: expect.stringMatching(/^\/book\//) }])
  })

  it('a step that sends no email does not move the page', async () => {
    const id = await apply(jobs[0]!, 'lim@example.test')
    await sendAll()
    await moveApplication(deps(), id, { node: 'manual_review' }, { reason: 'look myself' }, 'owner')
    await sendAll()
    expect((await status('lim@example.test')).applications[0]!.step).toBe(0)
  })

  it('a rejection shows only after its email went out; a silent close never shows', async () => {
    const told = await apply(jobs[0]!, 'ana@example.test')
    const silent = await apply(jobs[1]!, 'ana@example.test')
    await sendAll()
    await moveApplication(deps(), told, { close: 'rejected' }, { reasonCode: 'Other', notify: true }, 'owner')
    await moveApplication(deps(), silent, { close: 'rejected' }, { reasonCode: 'Other' }, 'owner')
    const outcomes = async () => Object.fromEntries((await status('ana@example.test')).applications.map(x => [x.id, x.outcome]))
    expect(await outcomes()).toEqual({ [told]: null, [silent]: null })
    await sendAll()
    expect(await outcomes()).toEqual({ [told]: 'rejected', [silent]: null })
  })

  it('an unknown or malformed token is a 404', async () => {
    for (const t of ['nope', 'x'.repeat(32)]) {
      const e = await publicStatus(db, t, NOW).catch(err => err)
      expect(e).toBeInstanceOf(DomainError)
      expect(e).toMatchObject({ status: 404 })
    }
  })
})

describe('email me my link', () => {
  it('nothing for an unknown address; once an hour for a known one, and it is no update', async () => {
    expect(await requestStatusLink(db, 'nobody@example.test', NOW, URL_)).toBeNull()
    expect(await requestStatusLink(db, ' WEI@example.test ', NOW, URL_)).toEqual(expect.any(String))
    expect(await requestStatusLink(db, 'wei@example.test', new Date(NOW.getTime() + 60_000), URL_)).toBeNull()
    await sendAll()
    expect((await status('wei@example.test')).updates.map(u => u.subject)).not.toContain('Your link to follow your applications')
  })
})
