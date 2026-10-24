import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REGISTRY } from '../shared/workflow/registry'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { availabilityInput, book, bookingIcs, freeSlots, publicBooking, putAvailability, runBooking } from '../server/domain/bookings'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { getTask } from '../server/domain/tasks'
import { type EngineDeps, type Enqueued, executeAutoRun, startApplication } from '../server/engine/engine'
import { testDb } from './db'

const weekdays = (from: string, to: string) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map(d => [d, [[from, to]] as [string, string][]]))
const NY = { timezone: 'America/New_York', hours: weekdays('09:00', '17:00') }
const LONDON = { timezone: 'Europe/London', hours: weekdays('09:00', '17:00') }
const day = (slots: string[], date: string) => slots.filter(x => x.startsWith(date))

describe('freeSlots', () => {
  it('follows each zone across a DST change (New York leaves EDT on 1 Nov 2026)', () => {
    const slots = freeSlots({ now: new Date('2026-10-29T12:00:00Z'), durationMin: 60, people: [NY], busy: [] })
    const fri = day(slots, '2026-10-30') // EDT, UTC-4
    expect([fri[0], fri.at(-1)]).toEqual(['2026-10-30T13:00:00.000Z', '2026-10-30T20:00:00.000Z'])
    const mon = day(slots, '2026-11-02') // EST, UTC-5
    expect([mon[0], mon.at(-1)]).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T21:00:00.000Z'])
    expect(day(slots, '2026-10-31')).toEqual([]) // weekend
    expect(slots.every(x => new Date(x).getTime() <= new Date('2026-11-12T12:00:00Z').getTime())).toBe(true) // 14 days
  })

  it('intersects everyone, keeps 12 h notice and skips other bookings', () => {
    const both = freeSlots({ now: new Date('2026-10-29T12:00:00Z'), durationMin: 60, people: [NY, LONDON], busy: [] })
    expect(day(both, '2026-11-02')).toEqual(['14:00', '14:30', '15:00', '15:30', '16:00'].map(h => `2026-11-02T${h}:00.000Z`))

    const soon = freeSlots({ now: new Date('2026-11-02T03:00:00Z'), durationMin: 60, people: [NY], busy: [] })
    expect(soon[0]).toBe('2026-11-02T15:00:00.000Z')

    const busy = [{ start: new Date('2026-11-02T15:00:00Z'), end: new Date('2026-11-02T16:00:00Z') }]
    const free = day(freeSlots({ now: new Date('2026-10-29T12:00:00Z'), durationMin: 60, people: [NY, LONDON], busy }), '2026-11-02')
    expect(free).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T16:00:00.000Z'])
  })

  it('a range may end at 24:00, and nobody set means no slots', () => {
    const late = freeSlots({ now: new Date('2026-10-29T00:00:00Z'), durationMin: 60, people: [{ timezone: 'UTC', hours: { fri: [['22:00', '24:00']] } }], busy: [] })
    expect(day(late, '2026-10-30')).toEqual(['2026-10-30T22:00:00.000Z', '2026-10-30T22:30:00.000Z', '2026-10-30T23:00:00.000Z'])
    expect(freeSlots({ now: new Date(), durationMin: 30, people: [], busy: [] })).toEqual([])
  })

  it('validates availability input', () => {
    expect(availabilityInput.safeParse(NY).success).toBe(true)
    expect(availabilityInput.safeParse({ ...NY, timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(availabilityInput.safeParse({ ...NY, hours: { mon: [['17:00', '09:00']] } }).success).toBe(false)
    expect(availabilityInput.safeParse({ ...NY, hours: { mon: [['9:00', '17:00']] } }).success).toBe(false)
    expect(availabilityInput.safeParse({ ...NY, hours: { funday: [['09:00', '17:00']] } }).success).toBe(false)
    expect(REGISTRY.human_task!.config.safeParse({ ...STANDARD_HIRE.workflow.nodes.find(n => n.key === 'interview')!.config, booking: { duration_min: 5 } }).success).toBe(false)
  })
})

describe('booking an interview', () => {
  const ADMIN = 'admin@example.test'
  let db: Db
  let t = new Date('2026-10-20T09:00:00Z')
  const queue: Enqueued[] = []
  const deps: () => EngineDeps = () => ({
    db,
    adminEmail: ADMIN,
    now: () => t,
    enqueue: async (items) => { queue.push(...items) },
    handlers: {
      cv_parse: async () => ({ output: { text: 'x', skills: [], years_experience: 6, current_title: 'Engineer', file_sha256: 'x' } }),
      ai_review: async () => ({ output: { skills_match: 90, experience: 80, overall: 85, summary: 'Strong' } }),
      send_email: async () => ({ output: { sent: true } }),
    },
  })
  let job: typeof s.jobs.$inferSelect
  let seq = 0

  // applies and runs to the interview task; returns its booking
  async function interview() {
    const [c] = await db.insert(s.candidates).values({ email: `c${++seq}@example.test`, firstName: 'Jane', lastName: 'Doe' }).returning()
    const [a] = await db.insert(s.applications).values({
      jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!,
      answers: { cv: { key: 'k', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' } },
    }).returning()
    await startApplication(deps(), a!.id)
    while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId)
    const [run] = await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, a!.id)).orderBy(desc(s.nodeRuns.seq)).limit(1)
    expect(run).toMatchObject({ nodeKey: 'interview', status: 'waiting_on_human' })
    const [b] = await db.select().from(s.bookings).where(eq(s.bookings.runId, run!.id))
    return { ...b!, applicationId: a!.id }
  }
  const rejects = async (p: Promise<unknown>, status: number, message: string) => {
    const e = await p.then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(DomainError)
    expect(e).toMatchObject({ status, message })
  }

  beforeAll(async () => {
    db = await testDb()
    const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
    const [employee] = await db.select().from(s.roles).where(eq(s.roles.name, 'Employee'))
    await db.insert(s.user).values([
      { id: 'owner', email: 'owner@example.test', name: 'Olivia Owner', roleId: manager!.id },
      { id: 'other', email: 'other@example.test', name: 'Other', roleId: employee!.id },
    ])
    await db.update(s.settings).set({ companyName: 'Acme, Inc.' })
    const tpl = structuredClone(STANDARD_HIRE)
    Object.assign(tpl.workflow.nodes.find(n => n.key === 'interview')!.config!, { booking: { duration_min: 60 } })
    const { job: j } = await createJob(db, 'owner', { title: 'Engineer; Backend', description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
    await saveDraft(db, j.id, tpl)
    await publish(db, j.id, ADMIN)
    job = (await db.query.jobs.findFirst({ where: eq(s.jobs.id, j.id) }))!
  })
  afterAll(() => db.close())

  it('the task gets a link; no availability yet means no slots', async () => {
    const b = await interview()
    expect(b.token).toMatch(/^[\w-]{32}$/)
    expect(b.durationMin).toBe(60)
    expect(await publicBooking(db, b.token, t)).toEqual({
      companyName: 'Acme, Inc.', jobTitle: 'Engineer; Backend', candidateFirstName: 'Jane', interviewers: ['Olivia Owner'],
      durationMin: 60, timezoneHint: null, startsAt: null, canBook: true, noAvailability: true, slots: [],
    })
  })

  it('happy path, then the slot is gone for the next candidate, rebooking, and the 12 h cut-off', async () => {
    await putAvailability(db, 'owner', { timezone: 'UTC', hours: { tue: [['09:00', '17:00']], wed: [['09:00', '17:00']] } })
    const first = await interview()
    const view = await publicBooking(db, first.token, t)
    expect(view).toMatchObject({ timezoneHint: 'UTC', noAvailability: false })
    expect(view.slots[0]).toBe('2026-10-21T09:00:00.000Z') // Tuesday 20th is inside the 12 h notice

    expect(await book(db, first.token, new Date('2026-10-21T10:00:00Z'), t)).toEqual({ startsAt: new Date('2026-10-21T10:00:00Z') })
    const [ev] = await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, first.applicationId), eq(s.applicationEvents.type, 'booked')))
    expect(ev!.data).toEqual({ runId: first.runId, startsAt: '2026-10-21T10:00:00.000Z', previous: null })
    expect((await getTask(db, { userId: 'owner', level: 'manager' }, first.runId, t)).booking).toEqual({ startsAt: new Date('2026-10-21T10:00:00Z') })

    const second = await interview()
    const offered = (await publicBooking(db, second.token, t)).slots
    expect(offered).not.toContain('2026-10-21T09:30:00.000Z')
    expect(offered).not.toContain('2026-10-21T10:00:00.000Z')
    expect(offered).toContain('2026-10-21T11:00:00.000Z')
    await rejects(book(db, second.token, new Date('2026-10-21T10:00:00Z'), t), 409, 'slot_unavailable')
    await rejects(book(db, second.token, new Date('2026-10-21T10:10:00Z'), t), 409, 'slot_unavailable') // off the grid

    await book(db, first.token, new Date('2026-10-21T13:00:00Z'), t) // rebook
    expect((await publicBooking(db, second.token, t)).slots).toContain('2026-10-21T10:00:00.000Z')
    await rejects(book(db, first.token, new Date('2026-10-22T13:00:00Z'), new Date('2026-10-21T02:00:00Z')), 409, 'too_late_to_change')
  })

  it('[race] two candidates taking the same slot at once: exactly one wins', async () => {
    const [a, b] = [await interview(), await interview()]
    const at = new Date('2026-10-28T14:00:00Z')
    const results = await Promise.allSettled([book(db, a.token, at, t), book(db, b.token, at, t)])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: 'slot_unavailable' })
  })

  it('unknown or malformed tokens are 404 everywhere', async () => {
    for (const token of ['nope', 'A'.repeat(32), "'; drop table bookings; --".padEnd(32, 'x')]) {
      await rejects(publicBooking(db, token, t), 404, 'booking_not_found')
      await rejects(book(db, token, new Date('2026-10-21T11:00:00Z'), t), 404, 'booking_not_found')
      await rejects(bookingIcs(db, token, t), 404, 'booking_not_found')
    }
  })

  it('the run booking is for managers and assignees only', async () => {
    const b = await interview()
    expect(await runBooking(db, { userId: 'owner', level: 'manager' }, b.runId)).toEqual({ token: b.token, durationMin: 60, startsAt: null })
    await rejects(runBooking(db, { userId: 'other', level: 'employee' }, b.runId), 404, 'booking_not_found')
    await rejects(bookingIcs(db, b.token, t), 404, 'booking_not_found') // nothing picked yet
  })

  it('.ics: CRLF, UTC times, UID from the booking, escaped text', async () => {
    const b = await interview()
    await book(db, b.token, new Date('2026-10-27T15:30:00Z'), t)
    const ics = await bookingIcs(db, b.token, t)
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    const lines = ics.split('\r\n')
    expect(lines.slice(0, 2)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0'])
    expect(lines).toContain(`UID:${b.id}@lanyard`)
    expect(lines).toContain('DTSTAMP:20261020T090000Z')
    expect(lines).toContain('DTSTART:20261027T153000Z')
    expect(lines).toContain('DTEND:20261027T163000Z')
    expect(lines).toContain('SUMMARY:Interview: Engineer\\; Backend')
    expect(lines).toContain('DESCRIPTION:Acme\\, Inc.\\nWith Olivia Owner')
    expect(lines.slice(-3)).toEqual(['END:VEVENT', 'END:VCALENDAR', ''])

    await db.update(s.settings).set({ companyName: 'é'.repeat(100) })
    const long = await bookingIcs(db, b.token, t)
    await db.update(s.settings).set({ companyName: 'Acme, Inc.' })
    expect(long.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75)).toBe(true) // folded
    expect(long.replace(/\r\n /g, '')).toContain(`DESCRIPTION:${'é'.repeat(100)}\\nWith Olivia Owner`)
  })
})
