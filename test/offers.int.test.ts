import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { createTemplate, listOffers, listTemplates, makeOffer, offerInput, publicOffer, respondToOffer, STANDARD_OFFER, withdrawOffer } from '../server/domain/offers'
import { type EngineDeps, moveApplication, startApplication } from '../server/engine/engine'
import { testDb } from './db'

const ADMIN = 'admin@example.test'
const NOW = new Date('2026-10-20T09:00:00Z')
let db: Db
let job: typeof s.jobs.$inferSelect
const deps = (now = NOW): EngineDeps => ({ db, handlers: {}, adminEmail: ADMIN, now: () => now, enqueue: async () => {} })

const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}

let seq = 0
async function apply() {
  const [c] = await db.insert(s.candidates).values({ email: `c${++seq}@example.test`, firstName: 'Jane', lastName: 'van Doe' }).returning()
  const [a] = await db.insert(s.applications).values({
    jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!,
    answers: { cv: { key: 'k', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' } },
  }).returning()
  await startApplication(deps(), a!.id)
  return a!.id
}
const offer = (appId: string, extra: object = {}) =>
  makeOffer(db, appId, offerInput.parse({ templateId: null, terms: { salary: '€60,000 a year', start_date: '2026-12-01', location: 'Lisbon' }, ...extra }), 'owner', NOW)
const app = async (id: string) => (await db.query.applications.findFirst({ where: eq(s.applications.id, id) }))!

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
  await db.insert(s.settings).values({ companyName: 'Acme' }).onConflictDoUpdate({ target: s.settings.id, set: { companyName: 'Acme' } })
  const created = await createJob(db, 'owner', { title: 'Baker', description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, created.job.id, structuredClone(STANDARD_HIRE))
  await publish(db, created.job.id, ADMIN)
  job = (await db.query.jobs.findFirst({ where: eq(s.jobs.id, created.job.id) }))!
})
afterAll(() => db.close())

describe('offer templates', () => {
  it('an empty library offers the built-in letter; saved ones replace it', async () => {
    expect(await listTemplates(db)).toEqual([STANDARD_OFFER])
    await createTemplate(db, { name: 'Part time', body: 'Hi {{candidate.first_name}}, {{offer.salary}} for {{job.title}}.' })
    expect((await listTemplates(db)).map(t => t.name)).toEqual(['Part time'])
  })
})

describe('offers', () => {
  it('renders the letter once with candidate, job, offer and company holes', async () => {
    const id = await apply()
    const o = await offer(id)
    expect(o.token).toMatch(/^[\w-]{32}$/)
    expect(o.url).toBe(`/offer/${o.token}`)
    expect(o.letter).toContain('Dear Jane,')
    expect(o.letter).toContain('**Baker** at Acme')
    expect(o.letter).toContain('€60,000 a year')
    expect(o.letter).toContain('2026-12-01')
    expect(o.letter).toContain('Lisbon')
    expect(o.letter).not.toContain('{{')

    const [tpl] = await listTemplates(db)
    const custom = await makeOffer(db, id, offerInput.parse({ templateId: tpl!.id, terms: { salary: '£20/h', start_date: '2026-12-01' } }), 'owner', NOW)
    expect(custom.letter).toBe('Hi Jane, £20/h for Baker.')
  })

  it('closing the application another way withdraws its offer, and a reopen does not revive it', async () => {
    const id = await apply()
    const o = await offer(id)
    await moveApplication(deps(), id, { close: 'rejected' }, { reasonCode: 'Other' }, 'owner')
    expect((await listOffers(db, id))[0]!.status).toBe('withdrawn')
    await moveApplication(deps(), id, { node: 'interview' }, { reason: 'appeal' }, 'owner')
    await rejects(respondToOffer(deps(), o.token, { action: 'accept', signedName: 'Jane van Doe' }), 409, 'offer_not_open')
  })

  it('keeps one sent offer per application: a new one withdraws the old', async () => {
    const id = await apply()
    const first = await offer(id)
    const second = await offer(id)
    expect((await listOffers(db, id)).map(o => [o.id, o.status])).toEqual([[second.id, 'sent'], [first.id, 'withdrawn']])
    await withdrawOffer(db, second.id, 'owner')
    await rejects(withdrawOffer(db, second.id, 'owner'), 409, 'offer_not_open')
    await rejects(respondToOffer(deps(), second.token, { action: 'decline' }), 409, 'offer_not_open')
  })

  it('accept checks the typed name, then hires', async () => {
    const id = await apply()
    const o = await offer(id)
    expect(await publicOffer(db, o.token)).toMatchObject({ company: 'Acme', jobTitle: 'Baker', candidateFirstName: 'Jane', status: 'sent', signedName: null, respondedAt: null })
    await rejects(respondToOffer(deps(), o.token, { action: 'accept', signedName: 'Jane Doe' }), 422, 'name_mismatch')
    expect(await respondToOffer(deps(), o.token, { action: 'accept', signedName: '  jane   VAN doe ' })).toEqual({ status: 'accepted' })
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'hired' })
    const [row] = await db.select().from(s.offers).where(eq(s.offers.id, o.id))
    expect(row).toMatchObject({ status: 'accepted', signedName: 'jane VAN doe' })
    expect(await publicOffer(db, o.token)).toMatchObject({ status: 'accepted', signedName: 'jane VAN doe', respondedAt: row!.respondedAt })
    const [move] = await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, id), eq(s.applicationEvents.type, 'manual_move')))
    expect((move!.data as any).reason).toBe('Offer accepted, signed by jane VAN doe')
    await rejects(respondToOffer(deps(), o.token, { action: 'decline' }), 409, 'offer_not_open')
    await rejects(offer(id), 409, 'application_closed')
  })

  it('decline closes as withdrawn', async () => {
    const id = await apply()
    const o = await offer(id)
    await respondToOffer(deps(), o.token, { action: 'decline' })
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'withdrawn' })
  })

  it('refuses expired offers and unknown or malformed tokens', async () => {
    const id = await apply()
    const o = await offer(id, { expiresAt: '2026-10-21T09:00:00Z' })
    await rejects(respondToOffer(deps(new Date('2026-10-22T00:00:00Z')), o.token, { action: 'decline' }), 409, 'offer_expired')
    expect(await app(id)).toMatchObject({ status: 'active' })
    await rejects(publicOffer(db, 'A'.repeat(32)), 404, 'offer_not_found')
    await rejects(publicOffer(db, '../etc'), 404, 'offer_not_found')
  })
})
