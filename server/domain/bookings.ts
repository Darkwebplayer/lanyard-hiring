import { and, asc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { Db, Tx } from '../db/client'
import { applicationEvents, applications, bookingOffers, bookings, candidates, jobs, nodeRuns, settings, taskAssignments, user } from '../db/schema'
import { atLeastManager } from './access'
import { heldThrough, type Viewer } from './applications'
import { queueEmail, words } from './emails'
import { DomainError } from './errors'
import { logoUrl } from './settings'

// Interview booking: once a human task with `booking` has its people, one of them offers times (booking_offers).
// On a panel the others say which they can make; the candidate is emailed only the times everyone can make,
// and picks one through the link (bookings.token), asks for other times with a note, or steps back.
// Nothing reads anyone's calendar: the interviewer checks their own before offering.

const LEAD_MS = 60 * 60_000 // an offered time starts at least this far ahead, and is no longer offered after that
const CHANGE_MS = 12 * 3_600_000 // the last moment a booked time can change on the link
const AHEAD_MS = 90 * 86_400_000
export const MAX_TIMES = 10

// 32 base64url chars = 192 random bits
export const newBookingToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')
const TOKEN = /^[\w-]{32}$/

export const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  }
  catch { return false }
}

export const offerInput = z.object({
  times: z.array(z.iso.datetime({ offset: true })).min(1).max(MAX_TIMES),
  timezone: z.string().max(100).refine(validZone, 'unknown time zone').optional(), // the offerer's, for the email
}).strict()
export const answerInput = z.object({
  answers: z.record(z.uuid(), z.boolean()),
  note: z.string().trim().max(1000).optional(),
}).strict()
export const noteInput = z.object({ note: z.string().trim().max(1000).optional() }).strict()

// ---------- what state a booking is in (pure) ----------

export type Stage = 'closed' | 'declined' | 'needs_times' | 'panel' | 'candidate' | 'booked'
interface Offer { id: string, startsAt: Date, answers: Record<string, boolean> }
interface Span { start: Date, end: Date }
interface BookingRow { durationMin: number, startsAt: Date | null, cancelledAt: Date | null, sentAt: Date | null, notedAt: Date | null, declinedAt: Date | null }

// options: what the candidate may pick now (sent, far enough ahead, and nobody on it booked since).
// pending: who on the panel still has to answer.
export function stageOf(b: BookingRow, open: boolean, offers: Offer[], people: string[], busy: Span[], now: Date) {
  const dur = b.durationMin * 60_000
  const options = b.sentAt
    ? offers.filter(o => o.startsAt.getTime() - now.getTime() >= LEAD_MS
      && !busy.some(x => x.start.getTime() < o.startsAt.getTime() + dur && o.startsAt.getTime() < x.end.getTime())).map(o => o.startsAt)
    : []
  const pending = !b.sentAt && offers.length ? people.filter(id => offers.some(o => o.answers[id] === undefined)) : []
  // ponytail: a panel whose last pending person is taken off waits until someone offers again; resolve on reassign if it bites
  const stage: Stage = !open || b.cancelledAt ? 'closed'
    : b.declinedAt ? 'declined'
    : !b.sentAt && offers.length ? 'panel'
    : options.length ? 'candidate'
    : b.startsAt && !b.notedAt ? 'booked'
    : 'needs_times'
  return { stage, options, pending }
}

// ---------- loading ----------

async function loadBooking(db: Db | Tx, token: string) {
  if (!TOKEN.test(token)) throw new DomainError(404, 'booking_not_found') // checked before any query
  const [b] = await bookingRows(db).where(eq(bookings.token, token))
  if (!b) throw new DomainError(404, 'booking_not_found')
  return b
}
const bookingRows = (db: Db | Tx) => db.select({
  id: bookings.id, runId: bookings.runId, durationMin: bookings.durationMin, startsAt: bookings.startsAt, location: bookings.location,
  cancelledAt: bookings.cancelledAt, token: bookings.token, offeredBy: bookings.offeredBy, timezone: bookings.timezone, sentAt: bookings.sentAt,
  note: bookings.note, notedAt: bookings.notedAt, teamNote: bookings.teamNote, declinedAt: bookings.declinedAt,
  status: nodeRuns.status, applicationId: nodeRuns.applicationId, firstName: candidates.firstName, lastName: candidates.lastName, jobTitle: jobs.title,
}).from(bookings)
  .innerJoin(nodeRuns, eq(nodeRuns.id, bookings.runId))
  .innerJoin(applications, eq(applications.id, nodeRuns.applicationId))
  .innerJoin(candidates, eq(candidates.id, applications.candidateId))
  .innerJoin(jobs, eq(jobs.id, applications.jobId))
type Booking = Awaited<ReturnType<typeof loadBooking>>

// Open assignees in assignment order.
const assignees = (db: Db | Tx, runId: string) =>
  db.select({ id: user.id, name: user.name, email: user.email })
    .from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId))
    .where(and(eq(taskAssignments.runId, runId), isNull(taskAssignments.closedAt)))
    .orderBy(asc(taskAssignments.assignedAt), asc(taskAssignments.userId))

// Other interviews of any of these people around the window: open assignments, or everyone on a finished run (it may still lie ahead).
async function busyFor(db: Db | Tx, people: string[], runId: string, now: Date): Promise<Span[]> {
  if (!people.length) return []
  return (await db.select({ start: bookings.startsAt, minutes: bookings.durationMin }).from(bookings)
    .innerJoin(nodeRuns, eq(nodeRuns.id, bookings.runId))
    .innerJoin(taskAssignments, eq(taskAssignments.runId, bookings.runId))
    .where(and(ne(bookings.runId, runId), ne(nodeRuns.status, 'cancelled'), isNull(bookings.cancelledAt), isNull(bookings.declinedAt),
      inArray(taskAssignments.userId, people), heldThrough,
      gt(bookings.startsAt, new Date(now.getTime() - 86_400_000)), lt(bookings.startsAt, new Date(now.getTime() + AHEAD_MS + 86_400_000)))))
    .map(r => ({ start: r.start!, end: new Date(r.start!.getTime() + r.minutes * 60_000) }))
}

const offersOf = (db: Db | Tx, bookingId: string) =>
  db.select({ id: bookingOffers.id, startsAt: bookingOffers.startsAt, answers: bookingOffers.answers }).from(bookingOffers)
    .where(eq(bookingOffers.bookingId, bookingId)).orderBy(asc(bookingOffers.startsAt))

// Everything about one booking, read together.
async function describe(db: Db | Tx, b: Booking, now: Date) {
  const people = await assignees(db, b.runId)
  const offers = await offersOf(db, b.id)
  const busy = await busyFor(db, people.map(p => p.id), b.runId, now)
  return { people, offers, busy, ...stageOf(b, b.status === 'waiting_on_human', offers, people.map(p => p.id), busy, now) }
}

// The team's view of every booking on these runs, for the inbox and Schedule. One booking at a time:
// ponytail: a few queries per booking; batch them if a person ever holds hundreds of interviews at once.
export async function bookingStates(db: Db, runIds: string[], viewerId: string, now: Date) {
  if (!runIds.length) return new Map<string, Awaited<ReturnType<typeof teamView>>>()
  const rows = await bookingRows(db).where(inArray(bookings.runId, runIds))
  const out = new Map<string, Awaited<ReturnType<typeof teamView>>>()
  for (const b of rows) out.set(b.runId, await teamView(db, b, viewerId, now))
  return out
}
async function teamView(db: Db | Tx, b: Booking, viewerId: string, now: Date) {
  const d = await describe(db, b, now)
  const name = (id: string | null) => d.people.find(p => p.id === id)?.name ?? null
  const mine = d.stage === 'panel' && d.pending.includes(viewerId)
  return {
    stage: d.stage,
    startsAt: b.startsAt, cancelledAt: b.cancelledAt, durationMin: b.durationMin, location: b.location,
    note: b.note, notedAt: b.notedAt, teamNote: b.teamNote, sentAt: b.sentAt, declinedAt: b.declinedAt,
    offeredBy: name(b.offeredBy),
    others: d.people.filter(p => p.id !== viewerId).map(p => p.name), // the rest of the panel
    pending: d.pending.map(name).filter(Boolean) as string[],
    // the times on the table: offered (waiting on the panel or the candidate), with this viewer's answer and clashes
    offers: d.stage === 'panel' || d.stage === 'candidate'
      ? d.offers.filter(o => d.stage === 'panel' || d.options.some(t => t.getTime() === o.startsAt.getTime())).map(o => ({
          id: o.id, startsAt: o.startsAt, mine: o.answers[viewerId] ?? null,
          clash: d.busy.some(x => x.start.getTime() < o.startsAt.getTime() + b.durationMin * 60_000 && o.startsAt.getTime() < x.end.getTime()),
        }))
      : [],
    mustAnswer: mine,
  }
}
export type BookingState = Awaited<ReturnType<typeof teamView>>

// ---------- the team: offer times, answer as a panel ----------

// Locks the application (like every run change) and checks the viewer is open on the run's task.
async function forAssignee(tx: Tx, viewer: Viewer, runId: string) {
  const [r] = await tx.select({ applicationId: nodeRuns.applicationId }).from(nodeRuns).where(eq(nodeRuns.id, runId))
  if (!r) throw new DomainError(404, 'booking_not_found')
  await tx.select({ id: applications.id }).from(applications).where(eq(applications.id, r.applicationId)).for('update')
  const [b] = await bookingRows(tx).where(eq(bookings.runId, runId))
  if (!b) throw new DomainError(404, 'booking_not_found')
  const [mine] = await tx.select({ id: taskAssignments.userId }).from(taskAssignments)
    .where(and(eq(taskAssignments.runId, runId), eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt)))
  if (!mine) throw new DomainError(404, 'booking_not_found')
  if (b.status !== 'waiting_on_human' || b.cancelledAt) throw new DomainError(409, 'booking_closed')
  return b
}

// The times go to the candidate once everyone on it has answered every time; only the times all said yes to.
// None left: back to the offerer with what the panel said.
async function settleOffers(tx: Tx, b: Booking, now: Date, appUrl: string) {
  const people = await assignees(tx, b.runId)
  const offers = await offersOf(tx, b.id)
  if (people.some(p => offers.some(o => o.answers[p.id] === undefined))) return false
  const ok = offers.filter(o => people.every(p => o.answers[p.id]))
  const no = offers.filter(o => !ok.includes(o)).map(o => o.id)
  if (no.length) await tx.delete(bookingOffers).where(inArray(bookingOffers.id, no))
  if (!ok.length) {
    await event(tx, b, 'times_none', { by: b.offeredBy })
    return false
  }
  await tx.update(bookings).set({ sentAt: now, note: null, notedAt: null }).where(eq(bookings.id, b.id))
  const [s] = await tx.select({ companyName: settings.companyName }).from(settings)
  await queueEmail(tx, {
    applicationId: b.applicationId, kind: 'booking_request', key: `times:${b.id}:${now.getTime()}`,
    ...words.bookingRequest({
      first: b.firstName, job: b.jobTitle, company: s?.companyName ?? null, url: `${appUrl}/book/${b.token}`,
      durationMin: b.durationMin, interviewers: people.map(p => p.name), location: b.location, times: ok.map(o => o.startsAt), timeZone: b.timezone ?? 'UTC',
    }),
  }, appUrl)
  return true
}

const event = (tx: Tx, b: Booking, type: string, data: Record<string, unknown>, actorId?: string | null) =>
  tx.insert(applicationEvents).values({ applicationId: b.applicationId, type, actorId, data: { runId: b.runId, ...data } }).returning({ id: applicationEvents.id })

// Offers new times (replacing any on the table): each in the future, apart from each other and from the
// panel's other interviews. A solo interviewer's times go straight to the candidate. Offering again after
// the candidate stepped back reopens it. Returns whether the candidate was emailed.
export async function offerTimes(db: Db, viewer: Viewer, runId: string, input: z.output<typeof offerInput>, now: Date, appUrl = '') {
  return db.transaction(async (tx) => {
    const b = await forAssignee(tx, viewer, runId)
    const dur = b.durationMin * 60_000
    const times = [...new Set(input.times.map(t => new Date(t).getTime()))].sort((x, y) => x - y)
    if (times.some(t => t - now.getTime() < LEAD_MS)) throw new DomainError(422, 'time_too_soon')
    if (times.some(t => t - now.getTime() > AHEAD_MS)) throw new DomainError(422, 'time_too_far')
    if (times.some((t, i) => i && t - times[i - 1]! < dur)) throw new DomainError(422, 'times_overlap')
    const people = await assignees(tx, runId)
    const busy = await busyFor(tx, people.map(p => p.id), runId, now)
    if (times.some(t => busy.some(x => x.start.getTime() < t + dur && t < x.end.getTime()))) throw new DomainError(409, 'time_taken')

    await tx.delete(bookingOffers).where(eq(bookingOffers.bookingId, b.id))
    await tx.insert(bookingOffers).values(times.map(t => ({ bookingId: b.id, startsAt: new Date(t), answers: { [viewer.userId]: true } })))
    await tx.update(bookings).set({ offeredBy: viewer.userId, timezone: input.timezone ?? b.timezone, sentAt: null, teamNote: null, declinedAt: null })
      .where(eq(bookings.id, b.id))
    await event(tx, b, 'times_offered', { count: times.length, panel: people.length > 1 }, viewer.userId)
    const sent = await settleOffers(tx, { ...b, timezone: input.timezone ?? b.timezone }, now, appUrl)
    return { sent, applicationId: b.applicationId }
  })
}

// A panel member says which of the offered times they can make. The last answer sends the times on.
export async function answerTimes(db: Db, viewer: Viewer, runId: string, input: z.output<typeof answerInput>, now: Date, appUrl = '') {
  return db.transaction(async (tx) => {
    const b = await forAssignee(tx, viewer, runId)
    const offers = await offersOf(tx, b.id)
    if (b.sentAt || !offers.length) throw new DomainError(409, 'nothing_to_answer')
    if (offers.some(o => input.answers[o.id] === undefined)) throw new DomainError(422, 'answer_every_time')
    for (const o of offers) await tx.update(bookingOffers).set({ answers: { ...o.answers, [viewer.userId]: input.answers[o.id]! } }).where(eq(bookingOffers.id, o.id))
    if (input.note) {
      const [me] = await tx.select({ name: user.name }).from(user).where(eq(user.id, viewer.userId))
      await tx.update(bookings).set({ teamNote: [b.teamNote, `${me!.name}: ${input.note}`].filter(Boolean).join('\n') }).where(eq(bookings.id, b.id))
    }
    const sent = await settleOffers(tx, b, now, appUrl)
    return { sent, applicationId: b.applicationId }
  })
}

// For the recruiter's Copy link and the authed calendar file. Managers, or anyone assigned to the run.
export async function runBooking(db: Db, viewer: Viewer, runId: string) {
  const [b] = await db.select({
    token: bookings.token, durationMin: bookings.durationMin, startsAt: bookings.startsAt, location: bookings.location, cancelledAt: bookings.cancelledAt,
    declinedAt: bookings.declinedAt, sentAt: bookings.sentAt, note: bookings.note, notedAt: bookings.notedAt,
  }).from(bookings).where(eq(bookings.runId, runId))
  if (!b) throw new DomainError(404, 'booking_not_found')
  if (!atLeastManager(viewer.level)) {
    const [mine] = await db.select({ runId: taskAssignments.runId }).from(taskAssignments)
      .where(and(eq(taskAssignments.runId, runId), eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt)))
    if (!mine) throw new DomainError(404, 'booking_not_found')
  }
  return b
}

// ---------- the candidate: the link ----------

// The public booking page. 404 for unknown tokens.
export async function publicBooking(db: Db, token: string, now: Date) {
  const b = await loadBooking(db, token)
  const d = await describe(db, b, now)
  const [s] = await db.select({ companyName: settings.companyName, logoKey: settings.logoKey }).from(settings)
  const live = d.stage !== 'closed' && d.stage !== 'declined'
  return {
    companyName: s?.companyName ?? null,
    logoUrl: logoUrl(s?.logoKey),
    jobTitle: b.jobTitle,
    candidateFirstName: b.firstName,
    interviewers: d.people.map(p => p.name),
    offeredBy: d.people.find(p => p.id === b.offeredBy)?.name ?? d.people[0]?.name ?? null,
    durationMin: b.durationMin,
    location: b.location,
    cancelled: !!b.cancelledAt,
    declined: !!b.declinedAt,
    closed: d.stage === 'closed',
    timezoneHint: b.timezone,
    startsAt: b.startsAt,
    options: d.options, // what they may pick now
    asked: live && !!b.notedAt && d.stage !== 'candidate' ? b.note : null, // they asked for other times and are waiting
    canChange: live && (!b.startsAt || b.startsAt.getTime() - now.getTime() >= CHANGE_MS),
  }
}

// The candidate's writes lock the application, then (for a pick) the assignees' user rows in id order,
// so two candidates can't take the same person's time at once.
async function forCandidate(tx: Tx, token: string, now: Date) {
  const found = await loadBooking(tx, token)
  await tx.select({ id: applications.id }).from(applications).where(eq(applications.id, found.applicationId)).for('update')
  return found
}

// Picks one of the offered times (or a new one of a fresh set). Emails "You're booked" in the candidate's zone
// (`timezone`, from their browser; else the offerer's). Returns the people, for their invites after commit.
export async function book(db: Db, token: string, startsAt: Date, now: Date, timezone?: string, appUrl = '') {
  return db.transaction(async (tx) => {
    const found = await forCandidate(tx, token, now)
    const ids = (await assignees(tx, found.runId)).map(p => p.id)
    if (ids.length) await tx.select({ id: user.id }).from(user).where(inArray(user.id, ids)).orderBy(asc(user.id)).for('no key update')
    const b = await loadBooking(tx, token) // re-read under the locks
    if (b.status !== 'waiting_on_human' || b.cancelledAt || b.declinedAt) throw new DomainError(409, 'booking_closed')
    if (b.startsAt && b.startsAt.getTime() - now.getTime() < CHANGE_MS) throw new DomainError(409, 'too_late_to_change')
    const d = await describe(tx, b, now)
    if (!d.options.some(t => t.getTime() === startsAt.getTime())) throw new DomainError(409, 'slot_unavailable')

    await tx.update(bookings).set({ startsAt, sentAt: null, note: null, notedAt: null }).where(eq(bookings.id, b.id))
    await tx.delete(bookingOffers).where(eq(bookingOffers.bookingId, b.id))
    const [ev] = await event(tx, b, 'booked', { startsAt: startsAt.toISOString(), previous: b.startsAt?.toISOString() ?? null })
    const [s] = await tx.select({ companyName: settings.companyName }).from(settings)
    const zone = (timezone && validZone(timezone) ? timezone : b.timezone) ?? 'UTC'
    await queueEmail(tx, {
      applicationId: b.applicationId, kind: 'booked', key: `booked:${ev!.id}`, // one per change: a move back to an earlier slot still confirms
      ...words.booked({
        first: b.firstName, job: b.jobTitle, company: s?.companyName ?? null, start: startsAt, durationMin: b.durationMin, location: b.location,
        timeZone: zone, url: `${appUrl}/book/${b.token}`, icsUrl: `${appUrl}/api/public/bookings/${b.token}/invite.ics`,
      }),
    }, appUrl)
    // the team hears it too, in their own words, with a calendar file of their own
    const team = d.people.map(p => ({
      key: `team-booked:${ev!.id}:${p.id}`,
      email: {
        to: p.email,
        ...words.teamBooked({
          first: p.name.split(' ')[0]!, candidate: `${b.firstName} ${b.lastName}`, job: b.jobTitle, start: startsAt, durationMin: b.durationMin,
          location: b.location, timeZone: b.timezone ?? zone, others: d.people.filter(x => x.id !== p.id).map(x => x.name),
          url: `${appUrl}/inbox/${b.runId}`, icsUrl: `${appUrl}/api/runs/${b.runId}/booking/invite.ics`, moved: !!b.startsAt,
        }),
      },
    }))
    return { startsAt, applicationId: b.applicationId, team }
  })
}

// "None of these work": the times come off the table and the note goes to the team, who offer new ones.
// A booked time stays until they pick a new one.
export async function askOtherTimes(db: Db, token: string, note: string | undefined, now: Date) {
  return db.transaction(async (tx) => {
    const b = await forCandidate(tx, token, now)
    if (b.status !== 'waiting_on_human' || b.cancelledAt || b.declinedAt) throw new DomainError(409, 'booking_closed')
    if (b.startsAt && b.startsAt.getTime() - now.getTime() < CHANGE_MS) throw new DomainError(409, 'too_late_to_change')
    await tx.delete(bookingOffers).where(eq(bookingOffers.bookingId, b.id))
    await tx.update(bookings).set({ sentAt: null, note: note || null, notedAt: now }).where(eq(bookings.id, b.id))
    await event(tx, b, 'times_requested', { note: note || null, booked: b.startsAt?.toISOString() ?? null })
    return { applicationId: b.applicationId }
  })
}

// "I'm no longer interested": the team hears it; nothing closes, they decide what happens next.
export async function declineInterview(db: Db, token: string, note: string | undefined, now: Date) {
  return db.transaction(async (tx) => {
    const b = await forCandidate(tx, token, now)
    if (b.status !== 'waiting_on_human' || b.cancelledAt) throw new DomainError(409, 'booking_closed')
    if (b.declinedAt) return { applicationId: b.applicationId }
    await tx.delete(bookingOffers).where(eq(bookingOffers.bookingId, b.id))
    await tx.update(bookings).set({ sentAt: null, note: note || null, notedAt: null, declinedAt: now }).where(eq(bookings.id, b.id))
    await event(tx, b, 'booking_declined', { note: note || null, startsAt: b.startsAt?.toISOString() ?? null })
    return { applicationId: b.applicationId }
  })
}

// ---------- calendar file ----------

const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
// Lines longer than 75 octets continue on the next line after a space (RFC 5545 §3.1).
function fold(line: string) {
  const enc = new TextEncoder()
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  return [...out, cur].join('\r\n ')
}

// The candidate's file says who they meet; the team's (by run, signed in) says whom they interview.
export async function bookingIcs(db: Db, token: string, now: Date, forTeam = false) {
  const b = await loadBooking(db, token)
  if (!b.startsAt || b.cancelledAt || b.declinedAt) throw new DomainError(404, 'booking_not_found')
  const people = await assignees(db, b.runId)
  const [s] = await db.select({ companyName: settings.companyName }).from(settings)
  const who = people.map(p => p.name).join(', ')
  const summary = forTeam ? `Interview: ${b.firstName} ${b.lastName}, ${b.jobTitle}` : `Interview: ${b.jobTitle}`
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lanyard//Interviews//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@lanyard`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(b.startsAt)}`,
    `DTEND:${icsTime(new Date(b.startsAt.getTime() + b.durationMin * 60_000))}`,
    `SUMMARY:${icsText(summary)}`,
    ...(b.location ? [`LOCATION:${icsText(b.location)}`] : []),
    ...(who || s?.companyName ? [`DESCRIPTION:${icsText([s?.companyName, who && `With ${who}`].filter(Boolean).join('\n'))}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n'
}
