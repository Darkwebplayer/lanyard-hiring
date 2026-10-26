import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { deliver, listEmails, queueEmail } from '../server/domain/emails'
import { EmailError } from '../server/engine/email'
import { createTemplate, listOffers, listTemplates, makeOffer, resendOffer, nameMatches, offerInput, publicOffer, recordAnswer, recordedAnswer, respondToOffer, STANDARD_OFFER, withdrawOffer } from '../server/domain/offers'
import { listTasks } from '../server/domain/tasks'
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
    expect(o.letter).toContain('1 December 2026')
    expect(o).not.toHaveProperty('warning')
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
    // the one opening is filled: still allowed, with a warning
    expect(await offer(await apply())).toMatchObject({ status: 'sent', warning: 'seats_full' })
  })

  it('name check tolerates order, case, punctuation and connectors, not missing words', () => {
    expect(nameMatches('Nurul Binte Hidayah', 'Nurul', 'Hidayah')).toBe(true)
    expect(nameMatches('nurul bte. hidayah', 'Nurul Binte', 'Hidayah')).toBe(true)
    expect(nameMatches('Muhammad Faizal bin Rahman', 'Muhammad Faizal', 'Rahman')).toBe(true)
    expect(nameMatches('Ravi Kumar s/o Subramaniam', 'Ravi Kumar', 'Subramaniam')).toBe(true)
    expect(nameMatches('Ravi Kumar Subramaniam', 'Ravi Kumar', 'S/O Subramaniam')).toBe(true)
    expect(nameMatches('Arjun A/L Raj', 'Arjun', 'Raj')).toBe(true)
    expect(nameMatches('Tan Wei Jie', 'Wei Jie', 'Tan')).toBe(true)
    expect(nameMatches('Tan Wei-Jie', 'Wei Jie', 'Tan')).toBe(true)
    expect(nameMatches('Chloé Lim', 'Chloe', 'Lim')).toBe(true)
    expect(nameMatches('Nurul Hidyah', 'Nurul', 'Hidayah')).toBe(false)
    expect(nameMatches('Wei Jie', 'Wei Jie', 'Tan')).toBe(false)
    expect(nameMatches('', 'Wei Jie', 'Tan')).toBe(false)
    // a name made only of connector-like words is compared word for word
    expect(nameMatches('al bin', 'Al', 'Bin')).toBe(true)
    expect(nameMatches('Al', 'Al', 'Bin')).toBe(false)
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

  // ---- the Make offer step, emails, recorded answers ----
  const mails = async (id: string) => (await listEmails(db, { userId: 'owner', level: 'manager' }, id)).reverse() // oldest first
  const atOffer = async () => {
    const id = await apply()
    await moveApplication(deps(), id, { node: 'make_offer' }, { reason: 'straight to an offer' }, 'owner')
    return id
  }

  it('Make offer emails the link; a decline on the link with a reason walks the flow to withdrawn', async () => {
    const id = await atOffer()
    const o = await makeOffer(db, id, offerInput.parse({ templateId: null, terms: { salary: 'SGD 4,800 a month', start_date: '2026-12-01' }, expiresAt: '2026-11-02T15:59:59Z' }), 'owner', NOW, 'https://hire.example')
    const [sent] = await mails(id)
    expect(sent).toMatchObject({ kind: 'offer', key: `offer:${o.id}`, subject: 'Your offer for Baker', sentAt: null })
    expect(sent!.body).toContain(`https://hire.example/offer/${o.token}`)
    expect(sent!.body).toContain('open until 2 November 2026')
    expect((await listOffers(db, id))[0]!.emailed).toMatchObject({ to: expect.stringMatching(/@example\.test$/) })

    await respondToOffer(deps(), o.token, { action: 'decline', reason: 'Took another offer' })
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'withdrawn', currentNodeKey: 'withdrawn' })
    const [step] = await db.select().from(s.nodeRuns).where(and(eq(s.nodeRuns.applicationId, id), eq(s.nodeRuns.nodeKey, 'make_offer')))
    expect(step).toMatchObject({ status: 'completed', output: { accepted: false, decline_reason: 'Took another offer' } })
    expect((await listOffers(db, id))[0]).toMatchObject({ status: 'declined', answer: { via: 'link', reason: 'Took another offer' } })
    expect((await mails(id)).map(m => m.kind)).toEqual(['offer', 'offer_declined'])

    // after commit, deliver sends what is queued, once
    const out: string[] = []
    expect(await deliver(db, async k => out.push(k), { applicationId: id })).toBe(2)
    expect(await deliver(db, async k => out.push(k), { applicationId: id })).toBe(0)
    expect(out).toEqual([`offer:${o.id}`, `offer:${o.id}:answer`])
    expect((await mails(id)).every(m => m.sentAt)).toBe(true)
    await rejects(listEmails(db, { userId: 'nobody', level: 'employee' }, id), 404, 'application_not_found')
    // an employee on the case sees that it was sent, not the body with the candidate's links
    await db.insert(s.taskAssignments).values({ runId: step!.id, userId: 'owner' })
      .onConflictDoUpdate({ target: [s.taskAssignments.runId, s.taskAssignments.userId], set: { closedAt: null } })
    const seen = await listEmails(db, { userId: 'owner', level: 'employee' }, id)
    expect(seen.map(m => [m.subject, m.body])).toEqual([['Your offer for Baker', null], ['Your offer for Baker', null]])
  })

  it('Send again twice in the same minute emails once', async () => {
    const id = await apply()
    const o = await offer(id)
    await resendOffer(db, o.id, new Date(NOW.getTime() + 1000))
    await resendOffer(db, o.id, new Date(NOW.getTime() + 2000))
    expect((await mails(id)).map(m => m.kind)).toEqual(['offer', 'offer'])
  })

  it('deliver moves past a failed send, gives up after 5 tries or a permanent error, and leaves run emails to their run', async () => {
    const id = await apply()
    const q = (kind: string, key: string) => queueEmail(db, { applicationId: id, kind, key, subject: key, text: 'x' }, '')
    await q('flow', 'run-1'); await q('rejection', 'down'); await q('rejection', 'ok'); await q('rejection', 'bad')
    const out: string[] = []
    const send = async (k: string) => {
      if (k === 'down') throw new EmailError('down', true)
      if (k === 'bad') throw new EmailError('bad address', false)
      out.push(k)
    }
    expect(await deliver(db, send, { applicationId: id })).toBe(1)
    expect(out).toEqual(['ok']) // not the flow email: a cancelled run's email must not go out later
    for (let i = 0; i < 4; i++) await deliver(db, send, { applicationId: id })
    const byKey = Object.fromEntries((await mails(id)).map(m => [m.key, m]))
    expect(byKey.down).toMatchObject({ sentAt: null, failedAt: expect.any(Date) })
    expect(byKey.bad).toMatchObject({ sentAt: null, failedAt: expect.any(Date) })
    expect(await deliver(db, async k => out.push(k), { applicationId: id })).toBe(0) // given up on
    expect(await deliver(db, async k => out.push(k), { key: 'run-1' })).toBe(1) // the run's own send, by key
    await expect(deliver(db, send, { key: 'down' })).rejects.toThrow('down') // by key, a failure throws for the caller to retry
  })

  it('a recorded yes walks on to documents, calls off a booked interview and can skip the confirmation', async () => {
    const id = await atOffer()
    const o = await offer(id)
    const [run] = await db.select().from(s.nodeRuns).where(and(eq(s.nodeRuns.applicationId, id), eq(s.nodeRuns.nodeKey, 'make_offer')))
    await db.insert(s.bookings).values({ runId: run!.id, token: 'b'.repeat(32), durationMin: 30, startsAt: new Date('2026-10-28T06:00:00Z') })
    const input = recordedAnswer.parse({ accepted: true, via: 'phone', note: 'Will sign Monday', notify: false })
    expect(await recordAnswer(deps(), o.id, input, { id: 'owner', name: 'Owner' })).toEqual({ status: 'accepted' })
    expect(await app(id)).toMatchObject({ status: 'active', currentNodeKey: 'documents' })
    expect((await listOffers(db, id))[0]).toMatchObject({ status: 'accepted', signedName: null, answer: { via: 'phone', note: 'Will sign Monday', by: { id: 'owner', name: 'Owner' } } })
    expect((await mails(id)).map(m => m.kind)).toEqual(['offer']) // no confirmation asked for
    const [b] = await db.select().from(s.bookings).where(eq(s.bookings.runId, run!.id))
    expect(b!.cancelledAt).toEqual(NOW)
    const evs = await db.select().from(s.applicationEvents).where(eq(s.applicationEvents.applicationId, id))
    expect(evs.filter(e => e.type === 'booking_cancelled').map(e => e.data)).toEqual([{ runId: run!.id, startsAt: '2026-10-28T06:00:00.000Z' }])
    expect((await listTasks(db, { userId: 'owner', level: 'employee' }, ADMIN, NOW)).calledOff!.map(r => r.applicationId)).toEqual([id])
    await rejects(recordAnswer(deps(), o.id, input, { id: 'owner', name: 'Owner' }), 409, 'offer_not_open')
  })

  it('an accept away from a Make offer step closes directly and still confirms by email', async () => {
    const id = await apply() // still at the CV step
    const o = await offer(id)
    await respondToOffer(deps(), o.token, { action: 'accept', signedName: 'Jane van Doe' })
    expect(await app(id)).toMatchObject({ status: 'closed', outcome: 'hired' })
    const welcome = (await mails(id)).at(-1)!
    expect(welcome).toMatchObject({ kind: 'offer_accepted', subject: 'Welcome to Acme' })
  })

  it('a reject by hand sends the flow’s rejection email only when asked', async () => {
    const quiet = await apply()
    await moveApplication(deps(), quiet, { close: 'rejected' }, { reasonCode: 'Other' }, 'owner')
    expect(await mails(quiet)).toEqual([])
    const told = await apply()
    await moveApplication(deps(), told, { close: 'rejected' }, { reasonCode: 'Other', notify: true }, 'owner')
    const [m] = await mails(told)
    expect(m).toMatchObject({ kind: 'rejection', subject: 'Your application for Baker' })
    expect(m!.body).toMatch(/^Hi Jane,\n\nThank you for applying for Baker\./)
  })
})
