import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jobPostingLd } from '../shared/jobPosting'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { hireReport } from '../server/domain/applications'
import { jobsFeedXml, openJobs, publicJob, submitApplication } from '../server/domain/apply'
import { createJob, publish, saveDraft, updateJob } from '../server/domain/jobs'
import { testDb } from './db'

const pdf = new Uint8Array(readFileSync(new URL('./fixtures/cv.pdf', import.meta.url)))
const now = new Date('2026-10-20T09:00:00Z')
const bucket = { put: async () => {}, delete: async () => {} }
let db: Db
const ids: Record<string, string> = {}

async function job(title: string, over: { requirements?: object, closesAt?: Date | null, description?: string } = {}, published = true) {
  const { job } = await createJob(db, 'owner', { title, description: over.description ?? '', requirements: over.requirements ?? {}, openings: 1, closesAt: over.closesAt ?? null }, { kind: 'blank' })
  if (published) {
    await saveDraft(db, job.id, STANDARD_HIRE)
    await publish(db, job.id, 'admin@example.test')
  }
  return job.id
}
const apply = (jobId: string, email: string, fields: Record<string, string> = {}) =>
  submitApplication(db, bucket, jobId, { fields: { first_name: 'A', last_name: 'B', email, notice_period_weeks: '2', ...fields }, files: { cv: { bytes: pdf, name: 'cv.pdf' } } }, now)

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
  await db.update(s.settings).set({ companyName: 'Fish & <Chips>', careersIntro: 'Small team, big kitchen.' })
  ids.open = await job('Cook ]]> & <Chef>', {
    description: '**Hot** kitchen',
    requirements: { location: 'Berlin, Germany', employment_type: 'Full-time', salary_min: 40000, salary_max: 50000, salary_currency: 'EUR', show_salary: true },
  })
  ids.remote = await job('Bookkeeper', { requirements: { location: 'Remote, Germany', workplace_type: 'remote', employment_type: 'Part-time', salary_min: 1, salary_currency: 'EUR' } })
  ids.draft = await job('Draft', {}, false)
  ids.closed = await job('Closed')
  await updateJob(db, ids.closed, { status: 'closed' })
  ids.expired = await job('Expired', { closesAt: new Date('2026-10-01T00:00:00Z') })
})
afterAll(() => db.close())

describe('careers list', () => {
  it('lists only open, published jobs before their closing date, with public fields', async () => {
    const { company, jobs } = await openJobs(db, now)
    expect(company).toEqual({ name: 'Fish & <Chips>', careersIntro: 'Small team, big kitchen.' })
    expect(jobs.map(j => j.title).sort()).toEqual(['Bookkeeper', 'Cook ]]> & <Chef>'])
    const cook = jobs.find(j => j.id === ids.open)!
    expect(cook).toMatchObject({ location: 'Berlin, Germany', employmentType: 'Full-time', workplaceType: null, salary: { min: 40000, max: 50000, currency: 'EUR' }, postedAt: expect.any(Date) })
    expect(jobs.find(j => j.id === ids.remote)!.salary).toBeNull() // show_salary off
    expect(JSON.stringify(jobs)).not.toContain('salary_min')
  })
})

describe('feed', () => {
  it('lists open jobs with absolute tagged links, escaped', async () => {
    const xml = jobsFeedXml('https://jobs.example.test', await openJobs(db, now), now)
    expect(xml.match(/<job>/g)).toHaveLength(2)
    expect(xml).not.toContain('Expired')
    expect(xml).toContain(`<url><![CDATA[https://jobs.example.test/apply/${ids.open}?src=feed]]></url>`)
    expect(xml).toContain('<title><![CDATA[Cook ]]]]><![CDATA[> & <Chef>]]></title>') // "]]>" can't end the CDATA early
    expect(xml).toContain('<company><![CDATA[Fish & <Chips>]]></company>')
    expect(xml).toContain('<city><![CDATA[Berlin]]></city><country><![CDATA[Germany]]></country>')
    expect(xml).toContain('<description><![CDATA[<p><strong>Hot</strong> kitchen</p>]]></description>')
    expect(xml).toContain('<salary><![CDATA[40000-50000 EUR]]></salary><jobtype><![CDATA[fulltime]]></jobtype>')
    // outside CDATA there is only markup
    expect(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')).not.toMatch(/[&]|<(?!\/?[a-zA-Z]+>|\?xml)/)
  })
})

describe('JobPosting JSON-LD', () => {
  it('maps a job to what Google job search reads', async () => {
    const page = await publicJob(db, ids.open, now)
    const ld = jobPostingLd(page, page.companyName, 'https://jobs.example.test/apply/x')
    expect(ld).toMatchObject({
      '@type': 'JobPosting', title: 'Cook ]]> & <Chef>', description: '<p><strong>Hot</strong> kitchen</p>', employmentType: 'FULL_TIME',
      datePosted: expect.stringMatching(/^\d{4}-/), hiringOrganization: { name: 'Fish & <Chips>' },
      jobLocation: { address: { addressLocality: 'Berlin', addressCountry: 'Germany' } },
      baseSalary: { currency: 'EUR', value: { minValue: 40000, maxValue: 50000, unitText: 'YEAR' } },
    })
    expect(ld).not.toHaveProperty('jobLocationType')
    const remote = await publicJob(db, ids.remote, now)
    const rl = JSON.parse(JSON.stringify(jobPostingLd(remote, remote.companyName, 'u')))
    expect(rl).toMatchObject({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'Germany' }, employmentType: 'PART_TIME' })
    expect(rl).not.toHaveProperty('jobLocation')
    expect(rl).not.toHaveProperty('baseSalary') // not shown
    expect(rl).not.toHaveProperty('validThrough')
  })
})

describe('source and consent', () => {
  it('stores the source normalised and no consent when Settings has no consent text', async () => {
    const id = await apply(ids.open, 'a@example.test', { source: '  LinkedIn ' + 'x'.repeat(60) })
    const app = await db.query.applications.findFirst({ where: eq(s.applications.id, id) })
    expect(app!.source).toBe(('linkedin ' + 'x'.repeat(60)).slice(0, 40))
    expect(app!.consent).toBeNull()
  })

  it('never lets an apply link pose as a spreadsheet import', async () => {
    const id = await apply(ids.open, 'imp@example.test', { source: 'Import' })
    expect((await db.query.applications.findFirst({ where: eq(s.applications.id, id) }))!.source).toBeNull()
  })

  it('records the consent text shown, and refuses an application without the tick', async () => {
    await db.update(s.settings).set({ consentText: 'We keep your data for 6 months.' })
    await expect(apply(ids.open, 'b@example.test', { source: 'feed' })).rejects.toMatchObject({ status: 422, issues: [{ message: 'consent: Required' }] })
    const id = await apply(ids.open, 'b@example.test', { source: 'feed', consent: 'on' })
    const app = await db.query.applications.findFirst({ where: eq(s.applications.id, id) })
    expect(app).toMatchObject({ source: 'feed', consent: { text: 'We keep your data for 6 months.', at: now.toISOString() } })
    const blank = await apply(ids.remote, 'c@example.test', { source: '  ', consent: 'true' })
    expect((await db.query.applications.findFirst({ where: eq(s.applications.id, blank) }))!.source).toBeNull()
  })

  it('the hires report counts applicants and hires by source', async () => {
    await apply(ids.remote, 'd@example.test', { source: 'feed', consent: 'true' }).then(id => db.update(s.applications).set({ status: 'closed', outcome: 'hired' }).where(eq(s.applications.id, id)))
    const { bySource } = await hireReport(db)
    expect(bySource).toEqual([
      { source: 'feed', applied: 2, hired: 1 },
      { source: null, applied: 2, hired: 0 }, // blank and the refused 'import' tag
      { source: expect.stringMatching(/^linkedin/), applied: 1, hired: 0 },
    ])
  })
})
