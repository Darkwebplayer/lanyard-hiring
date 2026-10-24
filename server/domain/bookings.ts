import { and, asc, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import type { Db, Tx } from '../db/client'
import { applicationEvents, applications, availability, bookings, candidates, jobs, nodeRuns, settings, taskAssignments, user } from '../db/schema'
import { atLeastManager } from './access'
import type { Viewer } from './applications'
import { DomainError } from './errors'

// Interview booking: a human task with `booking` gets a link (bookings.token) where the candidate picks a
// time all open assignees are free. Times are computed in each assignee's own zone with Intl.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const STEP_MS = 30 * 60_000
const NOTICE_MS = 12 * 3_600_000 // earliest bookable slot, and the last moment to rebook
const WINDOW_MS = 14 * 86_400_000

// 32 base64url chars = 192 random bits
export const newBookingToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')
const TOKEN = /^[\w-]{32}$/

// ---------- availability ----------

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'expected HH:MM')
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  }
  catch { return false }
}
export const availabilityInput = z.object({
  timezone: z.string().min(1).max(100).refine(validZone, 'unknown time zone'),
  hours: z.partialRecord(z.enum(DAYS), z.array(z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, 'start must be before end')).max(10)),
}).strict()
export type Availability = z.output<typeof availabilityInput>

export async function getAvailability(db: Db, userId: string) {
  const [row] = await db.select({ timezone: availability.timezone, hours: availability.hours }).from(availability).where(eq(availability.userId, userId))
  return row ?? { timezone: null, hours: {} }
}

export async function putAvailability(db: Db, userId: string, input: Availability) {
  const values = { timezone: input.timezone, hours: input.hours as Record<string, [string, string][]>, updatedAt: new Date() }
  const [row] = await db.insert(availability).values({ userId, ...values })
    .onConflictDoUpdate({ target: availability.userId, set: values })
    .returning({ timezone: availability.timezone, hours: availability.hours })
  return row!
}

// ---------- slots (pure) ----------

const formatters = new Map<string, Intl.DateTimeFormat>()
// Wall-clock day, date and minute of the day of an instant in a zone.
function local(t: number, timeZone: string) {
  let f = formatters.get(timeZone)
  if (!f) formatters.set(timeZone, f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))
  const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value]))
  return { day: p.weekday!.toLowerCase(), date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) }
}
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))

// Is [start, end) inside one of the person's ranges on one local day? Both ends are read in their zone, so a DST jump is exact.
function fits(a: Availability, start: number, end: number) {
  const s = local(start, a.timezone)
  const e = local(end, a.timezone)
  const endMin = e.date === s.date ? e.min : e.min === 0 && end - start < 86_400_000 ? 1440 : -1 // ending at midnight counts as 24:00
  return endMin > s.min && (a.hours[s.day as typeof DAYS[number]] ?? []).some(([from, to]) => toMin(from) <= s.min && endMin <= toMin(to))
}

export interface SlotInput {
  now: Date
  durationMin: number
  people: Availability[] // only assignees who set availability
  busy: { start: Date, end: Date }[] // other bookings of any of the assignees
}

// Starts on UTC :00/:30 for the next 14 days, at least 12 h out, inside everyone's hours, clear of other bookings.
// ponytail: UTC half-hour grid, so a :45-offset zone (Nepal) sees :15/:45 starts; step in the first person's zone if that matters.
export function freeSlots({ now, durationMin, people, busy }: SlotInput): string[] {
  if (!people.length) return []
  const dur = durationMin * 60_000
  const out: string[] = []
  for (let s = Math.ceil((now.getTime() + NOTICE_MS) / STEP_MS) * STEP_MS; s + dur <= now.getTime() + WINDOW_MS; s += STEP_MS) {
    const e = s + dur
    if (people.every(a => fits(a, s, e)) && !busy.some(b => b.start.getTime() < e && s < b.end.getTime())) out.push(new Date(s).toISOString())
  }
  return out
}

// ---------- the booking ----------

async function loadBooking(db: Db | Tx, token: string) {
  if (!TOKEN.test(token)) throw new DomainError(404, 'booking_not_found') // checked before any query
  const [b] = await db.select({
    id: bookings.id, runId: bookings.runId, durationMin: bookings.durationMin, startsAt: bookings.startsAt,
    status: nodeRuns.status, applicationId: nodeRuns.applicationId, firstName: candidates.firstName, jobTitle: jobs.title,
  }).from(bookings)
    .innerJoin(nodeRuns, eq(nodeRuns.id, bookings.runId))
    .innerJoin(applications, eq(applications.id, nodeRuns.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(bookings.token, token))
  if (!b) throw new DomainError(404, 'booking_not_found')
  return b
}

// Open assignees in assignment order, with their availability (null when not set).
const assignees = (db: Db | Tx, runId: string) =>
  db.select({ id: user.id, name: user.name, timezone: availability.timezone, hours: availability.hours })
    .from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId)).leftJoin(availability, eq(availability.userId, user.id))
    .where(and(eq(taskAssignments.runId, runId), isNull(taskAssignments.closedAt)))
    .orderBy(asc(taskAssignments.assignedAt), asc(taskAssignments.userId))

// The slots the assignees share right now.
async function offer(db: Db | Tx, b: Awaited<ReturnType<typeof loadBooking>>, now: Date) {
  const people = await assignees(db, b.runId)
  const withHours = people.filter(p => p.timezone).map(p => ({ timezone: p.timezone!, hours: p.hours! }))
  const canBook = b.status === 'waiting_on_human' && (!b.startsAt || b.startsAt.getTime() - now.getTime() >= NOTICE_MS)
  // other interviews of any of them: open assignments, or everyone on a finished run (it may still lie ahead)
  const busy = canBook && withHours.length
    ? (await db.select({ start: bookings.startsAt, minutes: bookings.durationMin }).from(bookings)
        .innerJoin(nodeRuns, eq(nodeRuns.id, bookings.runId))
        .innerJoin(taskAssignments, eq(taskAssignments.runId, bookings.runId))
        .where(and(ne(bookings.runId, b.runId), ne(nodeRuns.status, 'cancelled'), inArray(taskAssignments.userId, people.map(p => p.id)),
          or(isNull(taskAssignments.closedAt), eq(nodeRuns.status, 'completed')),
          gt(bookings.startsAt, new Date(now.getTime() - 86_400_000)), lt(bookings.startsAt, new Date(now.getTime() + WINDOW_MS)))))
        .map(r => ({ start: r.start!, end: new Date(r.start!.getTime() + r.minutes * 60_000) }))
    : []
  return {
    people,
    canBook,
    noAvailability: !withHours.length,
    slots: canBook ? freeSlots({ now, durationMin: b.durationMin, people: withHours, busy }) : [],
  }
}

// The public booking page. 404 for unknown tokens.
export async function publicBooking(db: Db, token: string, now: Date) {
  const b = await loadBooking(db, token)
  const o = await offer(db, b, now)
  const [s] = await db.select({ companyName: settings.companyName }).from(settings)
  return {
    companyName: s?.companyName ?? null,
    jobTitle: b.jobTitle,
    candidateFirstName: b.firstName,
    interviewers: o.people.map(p => p.name),
    durationMin: b.durationMin,
    timezoneHint: o.people.find(p => p.timezone)?.timezone ?? null,
    startsAt: b.startsAt,
    canBook: o.canBook,
    noAvailability: o.noAvailability,
    slots: o.slots,
  }
}

// Picks (or changes) the time. Locks the application (like every run change) and then the assignees' user rows
// in id order, so two candidates can't take the same person's slot at once.
export async function book(db: Db, token: string, startsAt: Date, now: Date) {
  return db.transaction(async (tx) => {
    const found = await loadBooking(tx, token)
    await tx.select({ id: applications.id }).from(applications).where(eq(applications.id, found.applicationId)).for('update')
    const ids = (await tx.select({ id: taskAssignments.userId }).from(taskAssignments)
      .where(and(eq(taskAssignments.runId, found.runId), isNull(taskAssignments.closedAt)))).map(r => r.id)
    if (ids.length) await tx.select({ id: user.id }).from(user).where(inArray(user.id, ids)).orderBy(asc(user.id)).for('no key update')
    const b = await loadBooking(tx, token) // re-read under the locks
    if (b.status !== 'waiting_on_human') throw new DomainError(409, 'booking_closed')
    if (b.startsAt && b.startsAt.getTime() - now.getTime() < NOTICE_MS) throw new DomainError(409, 'too_late_to_change')
    const { slots } = await offer(tx, b, now)
    if (!slots.includes(startsAt.toISOString())) throw new DomainError(409, 'slot_unavailable')
    await tx.update(bookings).set({ startsAt }).where(eq(bookings.id, b.id))
    await tx.insert(applicationEvents).values({ applicationId: b.applicationId, type: 'booked', data: { runId: b.runId, startsAt: startsAt.toISOString(), previous: b.startsAt?.toISOString() ?? null } })
    return { startsAt }
  })
}

// For the recruiter's Copy link. Managers, or anyone assigned to the run.
export async function runBooking(db: Db, viewer: Viewer, runId: string) {
  const [b] = await db.select({ token: bookings.token, durationMin: bookings.durationMin, startsAt: bookings.startsAt }).from(bookings).where(eq(bookings.runId, runId))
  if (!b) throw new DomainError(404, 'booking_not_found')
  if (!atLeastManager(viewer.level)) {
    const [mine] = await db.select({ runId: taskAssignments.runId }).from(taskAssignments)
      .where(and(eq(taskAssignments.runId, runId), eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt)))
    if (!mine) throw new DomainError(404, 'booking_not_found')
  }
  return b
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

export async function bookingIcs(db: Db, token: string, now: Date) {
  const b = await loadBooking(db, token)
  if (!b.startsAt) throw new DomainError(404, 'booking_not_found')
  const people = await assignees(db, b.runId)
  const [s] = await db.select({ companyName: settings.companyName }).from(settings)
  const who = people.map(p => p.name).join(', ')
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lanyard//Interviews//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@lanyard`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(b.startsAt)}`,
    `DTEND:${icsTime(new Date(b.startsAt.getTime() + b.durationMin * 60_000))}`,
    `SUMMARY:${icsText(`Interview: ${b.jobTitle}`)}`,
    ...(who || s?.companyName ? [`DESCRIPTION:${icsText([s?.companyName, who && `With ${who}`].filter(Boolean).join('\n'))}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n'
}
