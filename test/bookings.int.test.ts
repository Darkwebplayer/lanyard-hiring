import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REGISTRY } from '../shared/workflow/registry'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { answerTimes, askOtherTimes, book, bookingIcs, bookingStates, declineInterview, offerTimes, publicBooking, runBooking, stageOf } from '../server/domain/bookings'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { type EngineDeps, type Enqueued, executeAutoRun, startApplication } from '../server/engine/engine'
import { testDb } from './db'

const T = (iso: string) => new Date(`2026-10-${iso}Z`)

describe('stageOf', () => {
  const b = { durationMin: 60, startsAt: null, cancelledAt: null, sentAt: null, notedAt: null, declinedAt: null }
  const now = T('20T09:00:00')
  const o = (at: string, answers: Record<string, boolean> = { a: true }) => ({ id: at, startsAt: T(at), answers })
  it('needs times, then the panel, then the candidate; stale and taken times drop out', () => {
    expect(stageOf(b, true, [], ['a'], [], now).stage).toBe('needs_times')
    expect(stageOf(b, true, [o('21T10:00:00')], ['a', 'b'], [], now)).toMatchObject({ stage: 'panel', pending: ['b'] })
    const sent = { ...b, sentAt: now }
    expect(stageOf(sent, true, [o('21T10:00:00'), o('20T09:30:00')], ['a'], [], now)).toMatchObject({ stage: 'candidate', options: [T('21T10:00:00')] }) // 30 min away: gone
    const busy = [{ start: T('21T10:30:00'), end: T('21T11:00:00') }]
    expect(stageOf(sent, true, [o('21T10:00:00')], ['a'], busy, now)).toMatchObject({ stage: 'needs_times', options: [] }) // someone else took it
  })
  it('booked, a change asked for, stepped back, and closed', () => {
    expect(stageOf({ ...b, startsAt: T('22T10:00:00') }, true, [], ['a'], [], now).stage).toBe('booked')
    expect(stageOf({ ...b, startsAt: T('22T10:00:00'), notedAt: now }, true, [], ['a'], [], now).stage).toBe('needs_times')
    expect(stageOf({ ...b, declinedAt: now }, true, [], ['a'], [], now).stage).toBe('declined')
    expect(stageOf(b, false, [], ['a'], [], now).stage).toBe('closed')
  })
})

describe('booking an interview', () => {
  const ADMIN = 'admin@example.test'
  const OWNER = { userId: 'owner', level: 'manager' as const }
  const OTHER = { userId: 'other', level: 'employee' as const }
  let db: Db
  const t = T('20T09:00:00')
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

  // applies and runs to the interview task; returns its booking. panel: Other sits on it too.
  async function interview(panel = false) {
    const [c] = await db.insert(s.candidates).values({ email: `c${++seq}@example.test`, firstName: 'Jane', lastName: `Doe${seq}` }).returning()
    const [a] = await db.insert(s.applications).values({
      jobId: job.id, candidateId: c!.id, jobVersionId: job.publishedVersionId!,
      answers: { cv: { key: 'k', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' } },
    }).returning()
    await startApplication(deps(), a!.id)
    while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId)
    const [run] = await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, a!.id)).orderBy(desc(s.nodeRuns.seq)).limit(1)
    expect(run).toMatchObject({ nodeKey: 'interview', status: 'waiting_on_human' })
    if (panel) await db.insert(s.taskAssignments).values({ runId: run!.id, userId: 'other' })
    const [b] = await db.select().from(s.bookings).where(eq(s.bookings.runId, run!.id))
    return { ...b!, applicationId: a!.id }
  }
  const offer = (b: { runId: string }, times: string[], who = OWNER) => offerTimes(db, who, b.runId, { times: times.map(x => T(x).toISOString()), timezone: 'Asia/Singapore' }, t, 'https://hire.example')
  const stage = async (b: { runId: string }, who = 'owner') => (await bookingStates(db, [b.runId], who, t)).get(b.runId)!
  const mails = (b: { applicationId: string }, kind: string) => db.select().from(s.candidateEmails)
    .where(and(eq(s.candidateEmails.applicationId, b.applicationId), eq(s.candidateEmails.kind, kind))).orderBy(s.candidateEmails.seq)
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
      { id: 'other', email: 'other@example.test', name: 'Omar Other', roleId: employee!.id },
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

  it('the step makes a booking and sends nothing; the interviewer offers times first', async () => {
    const b = await interview()
    expect(b.token).toMatch(/^[\w-]{32}$/)
    expect(await mails(b, 'booking_request')).toEqual([])
    expect(await publicBooking(db, b.token, t)).toMatchObject({ interviewers: ['Olivia Owner'], options: [], startsAt: null, closed: false, declined: false, asked: null })
    expect((await stage(b)).stage).toBe('needs_times')
    expect(REGISTRY.human_task!.config.safeParse({ ...STANDARD_HIRE.workflow.nodes.find(n => n.key === 'interview')!.config, booking: { duration_min: 5 } }).success).toBe(false)
  })

  it('alone on it: the times go straight out, the candidate picks one, and the team hears it', async () => {
    const b = await interview()
    expect(await offer(b, ['21T02:00:00', '22T06:00:00'])).toEqual({ sent: true, applicationId: b.applicationId })
    const [ask] = await mails(b, 'booking_request')
    expect(ask!.subject).toBe('Pick a time for your interview, Jane')
    expect(ask!.body).toContain('Olivia Owner would like to meet you for 60 minutes. These times work:')
    expect(ask!.body).toContain('- Wednesday 21 October, 10:00 – 11:00 am (Singapore Standard Time)')
    expect(ask!.body).toContain('- Thursday 22 October, 2:00 – 3:00 pm (Singapore Standard Time)')
    expect(ask!.body).toContain(`https://hire.example/book/${b.token}`)
    expect((await publicBooking(db, b.token, t)).options).toEqual([T('21T02:00:00'), T('22T06:00:00')])

    await rejects(book(db, b.token, T('21T03:00:00'), t), 409, 'slot_unavailable') // not offered
    const r = await book(db, b.token, T('22T06:00:00'), t, 'Asia/Singapore', 'https://hire.example')
    expect(r.team).toEqual([{ key: expect.stringMatching(/^team-booked:/), email: expect.objectContaining({ to: 'owner@example.test', subject: 'Interview booked: Jane Doe2, Thu, 22 Oct, 2:00 pm SGT' }) }])
    expect(r.team[0]!.email.text).toContain(`https://hire.example/api/runs/${b.runId}/booking/invite.ics`)
    expect((await mails(b, 'booked'))[0]!.subject).toBe('You’re booked: Thu, 22 Oct, 2:00 pm SGT')
    expect(await stage(b)).toMatchObject({ stage: 'booked', startsAt: T('22T06:00:00'), offers: [] })
    expect((await publicBooking(db, b.token, t)).options).toEqual([]) // the rest leave the table
  })

  it('offered times must be ahead, apart, clear of the panel’s interviews, and from someone on it', async () => {
    const booked = await interview()
    await offer(booked, ['23T02:00:00'])
    await book(db, booked.token, T('23T02:00:00'), t)
    const b = await interview()
    await rejects(offer(b, ['20T09:30:00']), 422, 'time_too_soon')
    await rejects(offer(b, ['19T09:00:00']), 422, 'time_too_soon') // the past
    await rejects(offerTimes(db, OWNER, b.runId, { times: [new Date(t.getTime() + 91 * 86_400_000).toISOString()] }, t), 422, 'time_too_far')
    await rejects(offer(b, ['24T02:00:00', '24T02:30:00']), 422, 'times_overlap')
    await rejects(offer(b, ['23T02:30:00']), 409, 'time_taken')
    await rejects(offer(b, ['24T02:00:00'], OTHER), 404, 'booking_not_found')
    expect((await offer(b, ['24T02:00:00', '24T02:00:00'])).sent).toBe(true) // the same time twice is one
    expect((await stage(b)).offers).toHaveLength(1)
  })

  it('a time offered to two: the first to pick takes it; the other, with nothing left, needs times again', async () => {
    const [a, c] = [await interview(), await interview()]
    await offer(a, ['26T02:00:00', '26T04:00:00'])
    await offer(c, ['26T02:00:00'])
    await book(db, a.token, T('26T02:00:00'), t)
    expect((await publicBooking(db, c.token, t)).options).toEqual([])
    await rejects(book(db, c.token, T('26T02:00:00'), t), 409, 'slot_unavailable')
    expect((await stage(c)).stage).toBe('needs_times')
  })

  it('[race] two candidates taking the same time at once: exactly one wins', async () => {
    const [a, c] = [await interview(), await interview()]
    await offer(a, ['28T06:00:00'])
    await offer(c, ['28T06:00:00'])
    const results = await Promise.allSettled([book(db, a.token, T('28T06:00:00'), t), book(db, c.token, T('28T06:00:00'), t)])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: 'slot_unavailable' })
  })

  it('a panel: nothing goes out until everyone answers, then only the times all can make; none left goes back', async () => {
    const b = await interview(true)
    expect(await offer(b, ['27T02:00:00', '27T04:00:00', '27T06:00:00'])).toMatchObject({ sent: false })
    expect(await stage(b)).toMatchObject({ stage: 'panel', pending: ['Omar Other'], mustAnswer: false })
    const theirs = await stage(b, 'other')
    expect(theirs).toMatchObject({ mustAnswer: true, offeredBy: 'Olivia Owner' })
    expect(await mails(b, 'booking_request')).toEqual([])
    expect((await publicBooking(db, b.token, t)).options).toEqual([])

    const [x, y, z] = theirs.offers
    await rejects(answerTimes(db, OTHER, b.runId, { answers: { [x!.id]: true } }, t), 422, 'answer_every_time')
    expect(await answerTimes(db, OTHER, b.runId, { answers: { [x!.id]: true, [y!.id]: false, [z!.id]: true }, note: 'Not at noon' }, t)).toMatchObject({ sent: true })
    const [ask] = await mails(b, 'booking_request')
    expect(ask!.body).toContain('Olivia Owner and Omar Other would like to meet you for 60 minutes. These times work for both of them:')
    expect(ask!.body).not.toContain('12:00')
    expect((await publicBooking(db, b.token, t)).options).toEqual([T('27T02:00:00'), T('27T06:00:00')])
    await rejects(answerTimes(db, OTHER, b.runId, { answers: {} }, t), 409, 'nothing_to_answer')

    await offer(b, ['29T02:00:00']) // again, and this time Omar can't
    const [only] = (await stage(b, 'other')).offers
    expect(await answerTimes(db, OTHER, b.runId, { answers: { [only!.id]: false }, note: 'Away Thursday' }, t)).toMatchObject({ sent: false })
    expect(await stage(b)).toMatchObject({ stage: 'needs_times', teamNote: 'Omar Other: Away Thursday', offers: [] })
    const [none] = await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, b.applicationId), eq(s.applicationEvents.type, 'times_none')))
    expect(none!.data).toEqual({ runId: b.runId, by: 'owner' })
  })

  it('“none of these work” takes the times off the table; a booked time stays until a new pick; 12 h before, it can’t change', async () => {
    const b = await interview()
    await offer(b, ['30T02:00:00'])
    await askOtherTimes(db, b.token, 'Mornings are hard', t)
    expect(await stage(b)).toMatchObject({ stage: 'needs_times', note: 'Mornings are hard', offers: [] })
    expect(await publicBooking(db, b.token, t)).toMatchObject({ options: [], asked: 'Mornings are hard' })
    await rejects(book(db, b.token, T('30T02:00:00'), t), 409, 'slot_unavailable')

    await offer(b, ['30T06:00:00'])
    expect(await publicBooking(db, b.token, t)).toMatchObject({ options: [T('30T06:00:00')], asked: null })
    await book(db, b.token, T('30T06:00:00'), t)
    await askOtherTimes(db, b.token, undefined, t) // booked, wants to move
    expect(await stage(b)).toMatchObject({ stage: 'needs_times', startsAt: T('30T06:00:00') })
    await offer(b, ['31T06:00:00'])
    expect(await publicBooking(db, b.token, t)).toMatchObject({ startsAt: T('30T06:00:00'), options: [T('31T06:00:00')] })
    await book(db, b.token, T('31T06:00:00'), t)
    const [moved] = (await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, b.applicationId), eq(s.applicationEvents.type, 'booked'))).orderBy(desc(s.applicationEvents.seq)))
    expect(moved!.data).toMatchObject({ startsAt: '2026-10-31T06:00:00.000Z', previous: '2026-10-30T06:00:00.000Z' })

    const late = T('30T20:00:00')
    await rejects(askOtherTimes(db, b.token, 'x', late), 409, 'too_late_to_change')
    expect((await publicBooking(db, b.token, late)).canChange).toBe(false)
  })

  it('stepping back: the team hears it, nothing closes, and offering again reopens it', async () => {
    const b = await interview()
    await offer(b, ['30T08:00:00'])
    await declineInterview(db, b.token, 'Took another job', t)
    expect(await stage(b)).toMatchObject({ stage: 'declined', note: 'Took another job' })
    expect(await publicBooking(db, b.token, t)).toMatchObject({ declined: true, options: [] })
    await rejects(book(db, b.token, T('30T08:00:00'), t), 409, 'booking_closed')
    const [run] = await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.id, b.runId))
    expect(run!.status).toBe('waiting_on_human')
    await offer(b, ['30T10:00:00'])
    expect(await publicBooking(db, b.token, t)).toMatchObject({ declined: false, options: [T('30T10:00:00')] })
  })

  it('unknown or malformed tokens are 404 everywhere', async () => {
    for (const token of ['nope', 'A'.repeat(32), '\'; drop table bookings; --'.padEnd(32, 'x')]) {
      await rejects(publicBooking(db, token, t), 404, 'booking_not_found')
      await rejects(book(db, token, T('21T11:00:00'), t), 404, 'booking_not_found')
      await rejects(askOtherTimes(db, token, undefined, t), 404, 'booking_not_found')
      await rejects(declineInterview(db, token, undefined, t), 404, 'booking_not_found')
      await rejects(bookingIcs(db, token, t), 404, 'booking_not_found')
    }
  })

  it('the run booking is for managers and assignees only', async () => {
    const b = await interview()
    expect(await runBooking(db, OWNER, b.runId)).toMatchObject({ token: b.token, durationMin: 60, startsAt: null })
    await rejects(runBooking(db, OTHER, b.runId), 404, 'booking_not_found')
    await rejects(bookingIcs(db, b.token, t), 404, 'booking_not_found') // nothing picked yet
  })

  it('.ics: CRLF, UTC times, UID from the booking, escaped text; the team’s names the candidate', async () => {
    const b = await interview()
    await offer(b, ['27T15:30:00'])
    await book(db, b.token, T('27T15:30:00'), t)
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
    expect((await bookingIcs(db, b.token, t, true)).split('\r\n')).toContain(`SUMMARY:Interview: Jane Doe${seq}\\, Engineer\\; Backend`)

    await db.update(s.settings).set({ companyName: 'é'.repeat(100) })
    const long = await bookingIcs(db, b.token, t)
    await db.update(s.settings).set({ companyName: 'Acme, Inc.' })
    expect(long.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75)).toBe(true) // folded
    expect(long.replace(/\r\n /g, '')).toContain(`DESCRIPTION:${'é'.repeat(100)}\\nWith Olivia Owner`)
  })
})
