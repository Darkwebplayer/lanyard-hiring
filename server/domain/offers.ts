import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { render } from '../../shared/workflow/template'
import type { Db, Tx } from '../db/client'
import { applicationEvents, applications, candidateEmails, candidates, jobs, offers, offerTemplates, settings } from '../db/schema'
import { buildContext } from '../engine/context'
import { answerOfferStep, cancelBookings, type EngineDeps, type Enqueued, flush, moveApplication } from '../engine/engine'
import { queueEmail, words } from './emails'
import { DomainError } from './errors'

// Shown when the library is empty (and used for templateId: null), so a new company can make an offer at once.
export const STANDARD_OFFER = {
  id: null,
  name: 'Standard offer',
  builtIn: true,
  body: `Dear {{candidate.first_name}},

We're delighted to offer you the position of **{{job.title}}** at {{company.name}}. Everyone you met enjoyed getting to know you, and we'd love to have you on the team.

- **Salary:** {{offer.salary}}
- **Start date:** {{offer.start_date}}
- **Location:** {{offer.location}}

If you're happy with these terms, please accept this offer by typing your full name below. If you have any questions, just reply to us and we'll gladly talk them through.

We're looking forward to working with you.

Warm regards,
{{company.name}}`,
}

export const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(20_000),
})
export const templatePatch = templateInput.partial()

export async function listTemplates(db: Db) {
  const rows = await db.select().from(offerTemplates).orderBy(asc(offerTemplates.createdAt))
  return rows.length ? rows : [STANDARD_OFFER]
}

export async function createTemplate(db: Db, input: z.output<typeof templateInput>) {
  const [row] = await db.insert(offerTemplates).values(input).returning()
  return row!
}

export async function updateTemplate(db: Db, id: string, patch: z.output<typeof templatePatch>) {
  const [row] = await db.update(offerTemplates).set(patch).where(eq(offerTemplates.id, id)).returning()
  if (!row) throw new DomainError(404, 'template_not_found')
  return row
}

export async function deleteTemplate(db: Db, id: string) {
  const [row] = await db.delete(offerTemplates).where(eq(offerTemplates.id, id)).returning()
  if (!row) throw new DomainError(404, 'template_not_found')
  return row
}

// ---------- offers ----------

export const offerInput = z.object({
  templateId: z.uuid().nullable(),
  terms: z.object({
    salary: z.string().trim().min(1).max(100),
    start_date: z.iso.date(),
    location: z.string().trim().min(1).max(200).optional(),
  }),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
})

export const offerResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), signedName: z.string().max(300) }),
  z.object({ action: z.literal('decline'), reason: z.string().trim().max(200).optional() }), // reason: optional, the candidate's own words or a pick
])

// The team records an answer that came by phone, email or in person. Same effect as the link.
export const recordedAnswer = z.object({
  accepted: z.boolean(),
  via: z.enum(['phone', 'email', 'in_person']),
  note: z.string().trim().max(1000).optional(),
  reason: z.string().trim().max(200).optional(), // declined only
  notify: z.boolean().default(true), // email the candidate the same confirmation the link sends
})

// 32 base64url chars = 192 random bits
export const TOKEN = /^[\w-]{32}$/
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')

type Offer = typeof offers.$inferSelect
const view = (o: Offer) => ({ id: o.id, token: o.token, url: `/offer/${o.token}`, status: o.status, letter: o.letter, terms: o.terms, expiresAt: o.expiresAt, signedName: o.signedName, respondedAt: o.respondedAt, answer: o.answer, createdAt: o.createdAt })

const companyName = async (db: Pick<Db, 'select'>) => (await db.select({ name: settings.companyName }).from(settings))[0]?.name ?? ''

async function queueOfferEmail(tx: Db | Tx, o: Offer, key: string, appUrl: string) {
  const ctx = await buildContext(tx, o.applicationId)
  await queueEmail(tx, {
    applicationId: o.applicationId, kind: 'offer', key,
    ...words.offer({ first: ctx.candidate.first_name, job: ctx.job.title, company: await companyName(tx) || null, url: `${appUrl}/offer/${o.token}`, expiresAt: o.expiresAt }),
  })
}

// Renders the letter once, replaces any live offer, emails the candidate the link, and logs it. Only for active applications.
export async function makeOffer(db: Db, applicationId: string, input: z.output<typeof offerInput>, actorId: string, now: Date, appUrl = '') {
  if (input.expiresAt && new Date(input.expiresAt) <= now) throw new DomainError(422, 'expires_in_past')
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for('update')
    if (!app) throw new DomainError(404, 'application_not_found')
    if (app.status !== 'active') throw new DomainError(409, 'application_closed')
    let body = STANDARD_OFFER.body
    if (input.templateId) {
      const [tpl] = await tx.select().from(offerTemplates).where(eq(offerTemplates.id, input.templateId))
      if (!tpl) throw new DomainError(404, 'template_not_found')
      body = tpl.body
    }
    const ctx = await buildContext(tx, app.id)
    const letter = render(body, { ...ctx, offer: input.terms, company: { name: await companyName(tx) } })
    const replaced = await tx.update(offers).set({ status: 'withdrawn' })
      .where(and(eq(offers.applicationId, app.id), eq(offers.status, 'sent'))).returning({ id: offers.id })
    const [offer] = await tx.insert(offers).values({
      applicationId: app.id, token: newToken(), terms: input.terms, letter, createdBy: actorId,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    }).returning()
    await tx.insert(applicationEvents).values({ applicationId: app.id, type: 'offer_made', actorId, data: { offerId: offer!.id, replaced: replaced.map(r => r.id) } })
    await queueOfferEmail(tx, offer!, `offer:${offer!.id}`, appUrl)
    // allowed (a second offer may be a backup), but the UI can say every seat is already taken
    const [job] = await tx.select({ openings: jobs.openings }).from(jobs).where(eq(jobs.id, app.jobId))
    const [hires] = await tx.select({ n: count() }).from(applications).where(and(eq(applications.jobId, app.jobId), eq(applications.outcome, 'hired')))
    return { ...view(offer!), applicationId: app.id, ...(hires!.n >= job!.openings && { warning: 'seats_full' as const, openings: job!.openings, hired: hires!.n }) }
  })
}

// Emails the link again (a new email in the record). Only while the offer is open.
export async function resendOffer(db: Db, id: string, now: Date, appUrl = '') {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(offers).where(eq(offers.id, id))
    if (!o) throw new DomainError(404, 'offer_not_found')
    if (o.status !== 'sent' || (o.expiresAt && o.expiresAt <= now)) throw new DomainError(409, 'offer_not_open')
    await queueOfferEmail(tx, o, `offer:${o.id}:${now.toISOString().slice(0, 16)}`, appUrl) // per minute: a double click sends once
    return { applicationId: o.applicationId }
  })
}

// With when the link was last emailed, and to whom, for "Emailed to X on …".
export const listOffers = async (db: Db, applicationId: string) => {
  // single-table select: drizzle leaves columns unqualified, which inside the subquery would bind to e
  const id = sql`${offers}."id"`
  const rows = await db.select({
    offer: offers,
    emailed: sql<{ to: string, at: string } | null>`(select json_build_object('to', e.to, 'at', coalesce(e.sent_at, e.created_at)) from ${candidateEmails} e
      where e.application_id = ${applicationId} and e.kind = 'offer' and (e.idempotency_key = 'offer:' || ${id} or e.idempotency_key like 'offer:' || ${id} || ':%')
      order by e.seq desc limit 1)`,
  }).from(offers).where(eq(offers.applicationId, applicationId)).orderBy(desc(offers.createdAt))
  return rows.map(r => ({ ...view(r.offer), emailed: r.emailed }))
}

export async function withdrawOffer(db: Db, id: string, actorId: string) {
  return db.transaction(async (tx) => {
    const [o] = await tx.update(offers).set({ status: 'withdrawn' }).where(and(eq(offers.id, id), eq(offers.status, 'sent'))).returning()
    if (!o) {
      const [exists] = await tx.select({ id: offers.id }).from(offers).where(eq(offers.id, id))
      throw exists ? new DomainError(409, 'offer_not_open') : new DomainError(404, 'offer_not_found')
    }
    await tx.insert(applicationEvents).values({ applicationId: o.applicationId, type: 'offer_withdrawn', actorId, data: { offerId: o.id } })
    return view(o)
  })
}

// ---------- public (by token) ----------

async function loadOffer(db: Pick<Db, 'select'>, where: { token: string } | { id: string }) {
  if ('token' in where && !TOKEN.test(where.token)) throw new DomainError(404, 'offer_not_found') // never query with junk
  const [row] = await db.select({ offer: offers, app: applications, candidate: candidates, jobTitle: jobs.title })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where('token' in where ? eq(offers.token, where.token) : eq(offers.id, where.id))
  if (!row) throw new DomainError(404, 'offer_not_found')
  return row
}

export async function publicOffer(db: Db, token: string) {
  const { offer, candidate, jobTitle } = await loadOffer(db, { token })
  return { company: await companyName(db), jobTitle, candidateFirstName: candidate.firstName, letter: offer.letter, terms: offer.terms, status: offer.status, expiresAt: offer.expiresAt, signedName: offer.signedName, respondedAt: offer.respondedAt }
}

// Patronymic connectors (Malay bin/binte, Indian a/l, s/o…) that people add or leave out when they sign.
const CONNECTORS = new Set(['bin', 'binti', 'binte', 'bte', 'bt', 'b', 'a/l', 'a/p', 's/o', 'd/o', 'al', 'ap', 'so', 'do'])
const nameWords = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}/]+/u).filter(Boolean)
const nameTokens = (s: string) => new Set(nameWords(s).filter(t => !CONNECTORS.has(t)).map(t => t.replace(/\//g, '')).filter(Boolean))

// A light anti-typo check, not identity proof: every word of the name we hold must be typed, in any order,
// ignoring case, spacing, punctuation and connectors. Extra words (a middle name, "binte") are fine.
// A name made only of connector-like words ("Al Bin") is compared word for word instead.
export function nameMatches(typed: string, first: string, last: string) {
  const t = nameTokens(typed)
  const stored = nameTokens(`${first} ${last}`)
  if (!stored.size) return nameWords(`${first} ${last}`).length > 0 && nameWords(typed).join(' ') === nameWords(`${first} ${last}`).join(' ')
  return [...stored].every(w => t.has(w))
}

interface Answer {
  accepted: boolean
  via: 'link' | 'phone' | 'email' | 'in_person'
  signedName?: string
  reason?: string
  note?: string
  by?: { id: string, name: string } // recorded by the team; the link has nobody
  notify: boolean
}

// Accept or decline, by the link or recorded by the team, in one transaction: the offer is answered, the candidate
// gets the confirmation, a booked interview is called off on accept, and the application moves on. At a Make offer
// step the flow carries on (answerOfferStep); anywhere else it closes as hired / withdrawn directly.
async function answerOffer(deps: EngineDeps, where: { token: string } | { id: string }, a: Answer, appUrl: string) {
  const t = deps.now?.() ?? new Date()
  const out: Enqueued[] = []
  const done = await deps.db.transaction(async (tx) => {
    const { offer, app, candidate, jobTitle } = await loadOffer(tx, where)
    // same lock order as makeOffer: application, then offer
    const [locked] = await tx.select().from(applications).where(eq(applications.id, app.id)).for('update')
    const [current] = await tx.select().from(offers).where(eq(offers.id, offer.id)).for('update')
    if (current!.status !== 'sent' || locked!.status !== 'active') throw new DomainError(409, 'offer_not_open')
    // the link stops at the end date; the team may still record a yes that came in time
    if (a.via === 'link' && current!.expiresAt && current!.expiresAt <= t) throw new DomainError(409, 'offer_expired')
    if (a.via === 'link' && a.accepted && !nameMatches(a.signedName ?? '', candidate.firstName, candidate.lastName)) throw new DomainError(422, 'name_mismatch')
    const signedName = a.signedName?.trim().replace(/\s+/g, ' ') || null
    const answer = { via: a.via, ...(!a.accepted && a.reason && { reason: a.reason }), ...(a.note && { note: a.note }), ...(a.by && { by: a.by }) }
    await tx.update(offers).set({ status: a.accepted ? 'accepted' : 'declined', signedName, respondedAt: t, answer }).where(eq(offers.id, offer.id))
    // the candidate has no user account: link answers are attributed to whoever made the offer
    const actor = a.by?.id ?? offer.createdBy
    await tx.insert(applicationEvents).values({ applicationId: app.id, type: 'offer_answered', actorId: actor, data: { offerId: offer.id, accepted: a.accepted, via: a.via, ...(answer.reason && { reason: answer.reason }), ...(answer.note && { note: answer.note }) } })
    if (a.notify) {
      const who = { first: candidate.firstName, job: jobTitle, company: await companyName(tx) || null }
      await queueEmail(tx, {
        applicationId: app.id, kind: a.accepted ? 'offer_accepted' : 'offer_declined', key: `offer:${offer.id}:answer`,
        ...(a.accepted ? words.accepted({ ...who, url: `${appUrl}/offer/${offer.token}` }) : words.declined(who)),
      })
    }
    if (a.accepted) await cancelBookings(tx, app.id, t, actor)
    const nested = { ...deps, db: tx as unknown as Db, sendEmail: undefined } // emails go after the outer commit
    const walked = await answerOfferStep(tx, nested, locked!, { accepted: a.accepted, ...(answer.reason && { decline_reason: answer.reason }) }, actor, out)
    // moveApplication's own transaction becomes a savepoint inside this one; closing enqueues nothing.
    if (!walked) {
      await moveApplication(nested, app.id, { close: a.accepted ? 'hired' : 'withdrawn' }, {
        reason: a.accepted ? (signedName ? `Offer accepted, signed by ${signedName}` : `Offer accepted (${a.via.replace('_', ' ')})`) : 'Offer declined',
      }, actor)
    }
    return app.id
  })
  await flush(deps, out, done)
  return { status: a.accepted ? 'accepted' as const : 'declined' as const }
}

export const respondToOffer = (deps: EngineDeps, token: string, input: z.output<typeof offerResponse>) =>
  answerOffer(deps, { token }, input.action === 'accept'
    ? { accepted: true, via: 'link', signedName: input.signedName, notify: true }
    : { accepted: false, via: 'link', reason: input.reason || undefined, notify: true }, deps.appUrl ?? '')

export const recordAnswer = (deps: EngineDeps, offerId: string, input: z.output<typeof recordedAnswer>, by: { id: string, name: string }) =>
  answerOffer(deps, { id: offerId }, { ...input, by }, deps.appUrl ?? '')
