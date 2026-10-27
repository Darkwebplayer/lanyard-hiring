import { and, asc, desc, eq, isNull, lt, notInArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client'
import { applications, candidateEmails, candidates } from '../db/schema'
import { EmailError, type Email } from '../engine/email'
import { atLeastManager } from './access'
import { assertCanSee, type Viewer } from './applications'
import { getSettings } from './settings'

// Email is the documentary record: every email to a candidate goes through queueEmail, which writes it to
// candidate_emails in the caller's transaction (so it exists exactly when what caused it does), and deliver
// sends it after commit. The sweeper delivers whatever a crash left unsent.

export type Send = (idempotencyKey: string, email: Email) => Promise<unknown>
export interface CandidateEmail { applicationId: string, kind: string, key: string, subject: string, text: string }

// false when the key was already queued (the same email, asked for again). Every email ends with the link to
// their status page, and records where the application was, so the page moves only as the emails do.
export async function queueEmail(tx: Db | Tx, e: CandidateEmail, appUrl: string) {
  const [c] = await tx.select({ to: candidates.email, token: candidates.statusToken, nodeKey: applications.currentNodeKey }).from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(applications.id, e.applicationId))
  const body = `${e.text}\n\n${words.statusFooter((await getSettings(tx)).companyName, `${appUrl}/status/${c!.token}`)}`
  const inserted = await tx.insert(candidateEmails).values({ applicationId: e.applicationId, kind: e.kind, key: e.key, to: c!.to, subject: e.subject, body, nodeKey: c!.nodeKey })
    .onConflictDoNothing().returning({ id: candidateEmails.id })
  return inserted.length > 0
}

// Sent by a run's handler (key = run id), so the run's own retries resend them; a cancelled or failed run's
// unsent email must never go out later, so only a call by key sends these.
const RUN_OWNED = ['flow', 'documents']
const MAX_ATTEMPTS = 5

// Sends what is queued and unsent: one key, one application's, or (sweeper) everything older than `before`.
// A failed send counts an attempt and moves on; after MAX_ATTEMPTS or a permanent error the row is given up (failed_at).
// By key, a failure throws so the caller (a handler) can retry; the provider dedupes by key, so a crash between
// send and sent_at only resends the same key.
export async function deliver(db: Db, send: Send, only: { applicationId?: string, key?: string, before?: Date } = {}) {
  const rows = await db.select().from(candidateEmails).where(and(
    isNull(candidateEmails.sentAt),
    only.key ? eq(candidateEmails.key, only.key) : and(isNull(candidateEmails.failedAt), notInArray(candidateEmails.kind, RUN_OWNED)),
    only.applicationId ? eq(candidateEmails.applicationId, only.applicationId) : undefined,
    only.before ? lt(candidateEmails.createdAt, only.before) : undefined,
  )).orderBy(asc(candidateEmails.seq)).limit(100)
  if (!rows.length) return 0
  const { replyToEmail: replyTo } = await getSettings(db)
  let sent = 0
  for (const r of rows) {
    try {
      await send(r.key, { to: r.to, subject: r.subject, text: r.body, ...(replyTo && { replyTo }) })
    }
    catch (e) {
      const giveUp = r.attempts + 1 >= MAX_ATTEMPTS || (e instanceof EmailError && !e.retryable)
      await db.update(candidateEmails).set({ attempts: sql`${candidateEmails.attempts} + 1`, ...(giveUp && { failedAt: new Date() }) }).where(eq(candidateEmails.id, r.id))
      if (only.key) throw e
      console.error('[email] send failed', r.key, e)
      continue
    }
    await db.update(candidateEmails).set({ sentAt: new Date(), replyTo }).where(eq(candidateEmails.id, r.id))
    sent++
  }
  return sent
}

// After commit: a failed send stays queued for the sweeper rather than failing what already happened.
export const deliverLater = (db: Db, send: Send | undefined, applicationId: string) =>
  send ? deliver(db, send, { applicationId }).catch(e => console.error('[email] send failed; the sweeper retries', applicationId, e)) : undefined

// Newest first. Same access as the application, but only managers see the bodies: they carry the candidate's
// offer, booking and documents links, which act as the candidate.
export async function listEmails(db: Db, viewer: Viewer, applicationId: string) {
  await assertCanSee(db, viewer, applicationId)
  const rows = await db.select({
    id: candidateEmails.id, kind: candidateEmails.kind, key: candidateEmails.key, to: candidateEmails.to, replyTo: candidateEmails.replyTo,
    subject: candidateEmails.subject, body: candidateEmails.body, createdAt: candidateEmails.createdAt, sentAt: candidateEmails.sentAt, failedAt: candidateEmails.failedAt,
  }).from(candidateEmails).where(eq(candidateEmails.applicationId, applicationId)).orderBy(desc(candidateEmails.seq))
  return atLeastManager(viewer.level) ? rows : rows.map(r => ({ ...r, body: null }))
}

// ---------- the words ----------

const at = (company: string | null) => company ? ` at ${company}` : ''
const where = (location: string | null | undefined) => location ? `\n\nWhere: ${location}` : ''
const dayF = (timeZone: string) => new Intl.DateTimeFormat('en-SG', { timeZone, weekday: 'long', day: 'numeric', month: 'long' })
const timeF = (timeZone: string) => new Intl.DateTimeFormat('en-SG', { timeZone, hour: 'numeric', minute: '2-digit' })
const zoneName = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-SG', { timeZone, timeZoneName: 'long' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? timeZone

// "Wed, 28 Oct, 2:00 pm SGT" and "Wednesday 28 October, 2:00 – 2:45 pm (Singapore Standard Time)", in the candidate's zone.
export function interviewTime(start: Date, durationMin: number, timeZone: string) {
  const end = new Date(start.getTime() + durationMin * 60_000)
  const short = new Intl.DateTimeFormat('en-SG', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(start)
  const long = `${dayF(timeZone).format(start).replace(',', '')}, ${timeF(timeZone).formatRange(start, end)} (${zoneName(start, timeZone)})`
  const plain = (x: string) => x.replace(/[\u00a0\u2009\u202f]/g, ' ') // Intl's narrow spaces read as junk in some mail clients
  return { short: plain(short), long: plain(long) }
}

interface Who { first: string, job: string, company: string | null }

export const words = {
  // the offered times, in the offerer's zone (the page shows them in the candidate's own)
  bookingRequest: (w: Who & { url: string, durationMin: number, interviewers: string[], location?: string | null, times: Date[], timeZone: string }) => {
    const both = w.interviewers.length > 2 ? 'all of them' : 'both of them'
    const list = w.times.map(t => `- ${interviewTime(t, w.durationMin, w.timeZone).long}`).join('\n')
    return {
      subject: `Pick a time for your interview, ${w.first}`,
      text: `Hi ${w.first},\n\nThanks for applying for ${w.job}${at(w.company)}. ${w.interviewers.length ? `${w.interviewers.join(' and ')} would like to meet you` : 'We’d like to meet you'} for ${w.durationMin} minutes. ${w.interviewers.length > 1 ? `These times work for ${both}` : 'These times work'}:\n\n${list}${where(w.location)}\n\nPick the one that suits you. If none work, tell us when does:\n${w.url}`,
    }
  },
  // to each interviewer when a candidate books or moves a time
  teamBooked: (w: { first: string, candidate: string, job: string, start: Date, durationMin: number, timeZone: string, location?: string | null, others: string[], url: string, icsUrl: string, moved: boolean }) => {
    const t = interviewTime(w.start, w.durationMin, w.timeZone)
    return {
      subject: `${w.moved ? 'Interview moved' : 'Interview booked'}: ${w.candidate}, ${t.short}`,
      text: `Hi ${w.first},\n\n${w.candidate} ${w.moved ? 'moved' : 'booked'} the ${w.job} interview ${w.moved ? 'to' : 'for'} ${t.long}${w.others.length ? `, with ${w.others.join(' and ')}` : ''}.${where(w.location)}\n\nAdd it to your calendar: ${w.icsUrl}\n\nThe task: ${w.url}`,
    }
  },
  booked: (w: Who & { url: string, icsUrl: string, start: Date, durationMin: number, timeZone: string, location?: string | null }) => {
    const t = interviewTime(w.start, w.durationMin, w.timeZone)
    return {
      subject: `You’re booked: ${t.short}`,
      text: `Hi ${w.first},\n\nYour interview for ${w.job}${at(w.company)} is on ${t.long}.${where(w.location)}\n\nAdd it to your calendar: ${w.icsUrl}\n\nNeed another time? ${w.url}`,
    }
  },
  offer: (w: Who & { url: string, expiresAt: Date | null }) => ({
    subject: `Your offer for ${w.job}`,
    // ponytail: the end date is shown as a UTC day; right for Singapore (the recruiter picks the end of their day). Use a company time zone if others need it.
    text: `Hi ${w.first},\n\nWe’re pleased to offer you the ${w.job} role${at(w.company)}. Read the letter and answer here:\n${w.url}${w.expiresAt ? `\n\nThe offer is open until ${w.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.` : ''}`,
  }),
  accepted: (w: Who & { url: string }) => ({
    subject: `Welcome to ${w.company || 'the team'}`,
    text: `Hi ${w.first},\n\nThank you for accepting the ${w.job} offer. We’re glad to have you on board, and we’ll be in touch about your first day.\n\nYour offer letter stays here:\n${w.url}`,
  }),
  declined: (w: Who) => ({
    subject: `Your offer for ${w.job}`,
    text: `Hi ${w.first},\n\nThank you for letting us know you won’t be taking the ${w.job} role. We’re sorry it didn’t work out this time, and we wish you all the best.`,
  }),
  received: (w: Who) => ({
    subject: 'We got your application',
    text: `Hi ${w.first},\n\nThanks for applying for ${w.job}${at(w.company)}. We read every application and will email you when there’s news.`,
  }),
  statusLink: (first: string) => ({
    subject: 'Your link to follow your applications',
    text: `Hi ${first},\n\nYou asked for your link. It shows where each of your applications is.`,
  }),
  statusFooter: (company: string | null, url: string) => `Follow your applications${company ? ` with ${company}` : ''}:\n${url}`,
  rejection: (w: Who) => ({
    subject: `Your application for ${w.job}`,
    text: `Hi ${w.first},\n\nThank you for applying for ${w.job}${at(w.company)}. We have decided not to move forward this time. We wish you all the best with your search.`,
  }),
}
