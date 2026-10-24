import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { render } from '../../shared/workflow/template'
import type { Db } from '../db/client'
import { applicationEvents, applications, candidates, jobs, offers, offerTemplates, settings } from '../db/schema'
import { buildContext } from '../engine/context'
import { type EngineDeps, moveApplication } from '../engine/engine'
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
  z.object({ action: z.literal('decline') }),
])

// 32 base64url chars = 192 random bits
export const TOKEN = /^[\w-]{32}$/
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')

type Offer = typeof offers.$inferSelect
const view = (o: Offer) => ({ id: o.id, token: o.token, url: `/offer/${o.token}`, status: o.status, letter: o.letter, terms: o.terms, expiresAt: o.expiresAt, signedName: o.signedName, respondedAt: o.respondedAt, createdAt: o.createdAt })

const companyName = async (db: Pick<Db, 'select'>) => (await db.select({ name: settings.companyName }).from(settings))[0]?.name ?? ''

// Renders the letter once, replaces any live offer, and logs it. Only for active applications.
export async function makeOffer(db: Db, applicationId: string, input: z.output<typeof offerInput>, actorId: string, now: Date) {
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
    return view(offer!)
  })
}

export const listOffers = async (db: Db, applicationId: string) =>
  (await db.select().from(offers).where(eq(offers.applicationId, applicationId)).orderBy(desc(offers.createdAt))).map(view)

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

async function byToken(db: Pick<Db, 'select'>, token: string) {
  if (!TOKEN.test(token)) throw new DomainError(404, 'offer_not_found') // never query with junk
  const [row] = await db.select({ offer: offers, app: applications, candidate: candidates, jobTitle: jobs.title })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(offers.token, token))
  if (!row) throw new DomainError(404, 'offer_not_found')
  return row
}

export async function publicOffer(db: Db, token: string) {
  const { offer, candidate, jobTitle } = await byToken(db, token)
  return { company: await companyName(db), jobTitle, candidateFirstName: candidate.firstName, letter: offer.letter, terms: offer.terms, status: offer.status, expiresAt: offer.expiresAt, signedName: offer.signedName, respondedAt: offer.respondedAt }
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

// Accept (typed full name) or decline, then close the application as hired / withdrawn, all in one transaction.
export async function respondToOffer(deps: EngineDeps, token: string, input: z.output<typeof offerResponse>) {
  const t = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx) => {
    const { offer, app, candidate } = await byToken(tx, token)
    // same lock order as makeOffer: application, then offer
    const [locked] = await tx.select().from(applications).where(eq(applications.id, app.id)).for('update')
    const [current] = await tx.select().from(offers).where(eq(offers.id, offer.id)).for('update')
    if (current!.status !== 'sent' || locked!.status !== 'active') throw new DomainError(409, 'offer_not_open')
    if (current!.expiresAt && current!.expiresAt <= t) throw new DomainError(409, 'offer_expired')
    const accept = input.action === 'accept'
    if (accept && norm(input.signedName) !== norm(`${candidate.firstName} ${candidate.lastName}`)) throw new DomainError(422, 'name_mismatch')
    const signedName = accept ? input.signedName.trim().replace(/\s+/g, ' ') : null
    await tx.update(offers).set({ status: accept ? 'accepted' : 'declined', signedName, respondedAt: t }).where(eq(offers.id, offer.id))
    // moveApplication's own transaction becomes a savepoint inside this one; closing enqueues nothing.
    // The event is attributed to whoever made the offer: the candidate has no user account.
    await moveApplication({ ...deps, db: tx as unknown as Db }, app.id,
      { close: accept ? 'hired' : 'withdrawn' }, { reason: accept ? `Offer accepted, signed by ${signedName}` : 'Offer declined' }, offer.createdBy)
    return { status: accept ? 'accepted' as const : 'declined' as const }
  })
}
