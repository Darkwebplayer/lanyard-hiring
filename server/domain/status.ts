import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { candidateSteps, endsFlow } from '../../shared/workflow/stages'
import type { Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applications, bookings, candidateEmails, candidates, documentRequests, jobs, jobVersions, nodeRuns, offers } from '../db/schema'
import { queueEmail, words } from './emails'
import { DomainError } from './errors'
import { getSettings, logoUrl } from './settings'

// A candidate's status page: every application they made here, as far as our emails have told them. Progress,
// outcomes and things to do appear only once the email that says so has been sent, so the page never says more
// than their inbox does. Stage names are the candidate-facing ones; internal names and notes never leave.

const TOKEN = /^[\w-]{32}$/
const CLOSING = ['rejection', 'offer_accepted', 'offer_declined']
const OPEN_RUN = ['pending', 'running', 'waiting_on_human']

export async function publicStatus(db: Db, token: string, now: Date) {
  if (!TOKEN.test(token)) throw new DomainError(404, 'not_found')
  const [c] = await db.select().from(candidates).where(eq(candidates.statusToken, token))
  if (!c) throw new DomainError(404, 'not_found')
  const apps = await db.select({ app: applications, title: jobs.title, workflow: jobVersions.workflow }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(jobVersions, eq(jobVersions.id, applications.jobVersionId))
    .where(eq(applications.candidateId, c.id)).orderBy(desc(applications.createdAt))
  const ids = apps.map(a => a.app.id)
  const settings = await getSettings(db)
  const base = { companyName: settings.companyName, logoUrl: logoUrl(settings.logoKey), contactEmail: settings.replyToEmail, firstName: c.firstName }
  if (!ids.length) return { ...base, applications: [], todo: [], updates: [] }

  const sent = await db.select({
    id: candidateEmails.id, applicationId: candidateEmails.applicationId, kind: candidateEmails.kind, key: candidateEmails.key,
    subject: candidateEmails.subject, body: candidateEmails.body, sentAt: candidateEmails.sentAt, nodeKey: candidateEmails.nodeKey,
  }).from(candidateEmails)
    .where(and(inArray(candidateEmails.applicationId, ids), isNotNull(candidateEmails.sentAt), ne(candidateEmails.kind, 'status_link')))
    .orderBy(desc(candidateEmails.seq))
  const told = new Set(sent.map(e => e.key))

  const books = await db.select({ b: bookings, applicationId: nodeRuns.applicationId, runStatus: nodeRuns.status }).from(bookings)
    .innerJoin(nodeRuns, eq(nodeRuns.id, bookings.runId)).where(inArray(nodeRuns.applicationId, ids))
  const docs = await db.select({ d: documentRequests, runStatus: nodeRuns.status }).from(documentRequests)
    .innerJoin(nodeRuns, eq(nodeRuns.id, documentRequests.runId)).where(inArray(documentRequests.applicationId, ids))
  const offs = await db.select().from(offers).where(inArray(offers.applicationId, ids)).orderBy(desc(offers.createdAt))

  const todo: { kind: 'book' | 'documents' | 'offer', applicationId: string, job: string, url: string, durationMin?: number, until?: Date | null }[] = []
  const list = apps.map(({ app, title, workflow }) => {
    const graph = workflow as Graph
    const mine = sent.filter(e => e.applicationId === app.id)
    const { steps, stepOf } = candidateSteps(graph)
    const closing = mine.find(e => CLOSING.includes(e.kind) || (e.kind === 'flow' && endsFlow(graph, e.nodeKey)))
    const outcome = app.status === 'closed' && closing ? app.outcome : null
    const step = outcome === 'hired' ? steps.length - 1 : mine.map(e => stepOf(e.nodeKey)).find(i => i !== undefined) ?? 0
    const live = app.status === 'active' && !outcome

    let interview: { startsAt: Date, url: string } | null = null
    if (live) {
      for (const { b, applicationId, runStatus } of books) {
        if (applicationId !== app.id || b.cancelledAt || runStatus !== 'waiting_on_human' || !told.has(`booking:${b.id}`)) continue
        if (!b.startsAt) todo.push({ kind: 'book', applicationId: app.id, job: title, url: `/book/${b.token}`, durationMin: b.durationMin })
        else if (b.startsAt > now) interview = { startsAt: b.startsAt, url: `/book/${b.token}` }
      }
      const asked = mine.some(e => e.kind === 'documents' || e.kind === 'documents_reminder')
      for (const { d, runStatus } of docs) {
        if (d.applicationId === app.id && asked && OPEN_RUN.includes(runStatus) && d.items.some(i => i.required && !i.received)) {
          todo.push({ kind: 'documents', applicationId: app.id, job: title, url: `/documents/${d.token}` })
        }
      }
      const offer = offs.find(o => o.applicationId === app.id && o.status === 'sent' && (!o.expiresAt || o.expiresAt > now))
      if (offer && mine.some(e => e.kind === 'offer' && e.key.startsWith(`offer:${offer.id}`))) {
        todo.push({ kind: 'offer', applicationId: app.id, job: title, url: `/offer/${offer.token}`, until: offer.expiresAt })
      }
    }
    const accepted = outcome === 'hired' ? offs.find(o => o.applicationId === app.id && o.status === 'accepted') : undefined
    return {
      id: app.id,
      job: title,
      appliedAt: app.createdAt,
      steps,
      step,
      outcome, // only once the email that closed it was sent
      closedAt: outcome ? closing!.sentAt : null,
      interview,
      offerUrl: accepted ? `/offer/${accepted.token}` : null,
      startDate: accepted?.terms.start_date ?? null,
    }
  })
  // still going first, then ended; newest first within each
  list.sort((a, b) => Number(!!a.outcome) - Number(!!b.outcome))
  const jobOf = new Map(apps.map(a => [a.app.id, a.title]))
  return {
    ...base,
    applications: list,
    todo,
    updates: sent.slice(0, 50).map(e => ({ id: e.id, applicationId: e.applicationId, job: jobOf.get(e.applicationId)!, subject: e.subject, body: e.body, sentAt: e.sentAt })),
  }
}

// "Email me my link": the same answer whatever the address, so nobody can learn who applied. Once an hour per
// candidate (the key), so the form can't flood an inbox. Returns the application to deliver for, if any.
export async function requestStatusLink(db: Db, email: string, now: Date, appUrl: string) {
  const [row] = await db.select({ applicationId: applications.id, first: candidates.firstName, candidateId: candidates.id }).from(candidates)
    .innerJoin(applications, eq(applications.candidateId, candidates.id))
    .where(eq(candidates.email, email.trim().toLowerCase())).orderBy(desc(applications.createdAt)).limit(1)
  if (!row) return null
  const queued = await queueEmail(db, {
    applicationId: row.applicationId, kind: 'status_link', key: `status_link:${row.candidateId}:${now.toISOString().slice(0, 13)}`, ...words.statusLink(row.first),
  }, appUrl)
  return queued ? row.applicationId : null
}
