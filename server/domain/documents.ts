import { and, eq, inArray, isNull } from 'drizzle-orm'
import { MAX_FILE_BYTES } from '../../shared/workflow/form'
import type { Db } from '../db/client'
import { applicationEvents, applications, candidates, type DocItem, documentRequests, jobs, nodeRuns, settings, taskAssignments } from '../db/schema'
import type { Email } from '../engine/email'
import { type EngineDeps, type Enqueued, finishDocuments, flush } from '../engine/engine'
import { sha256Hex, sniffCv } from '../engine/handlers/extract'
import { atLeastManager } from './access'
import { queueEmail } from './emails'
import { assertCanSee, type Viewer } from './applications'
import type { Bucket } from './apply'
import { DomainError } from './errors'

// Request documents: the candidate uploads each one through a link (document_requests.token), the team can
// tick one off when it came another way, and the step completes once every required one is in.

const TOKEN = /^[\w-]{32}$/ // 192 random bits, made by newBookingToken
export const DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png'] as const

// By magic bytes, never the extension or the client's content-type.
export function sniffDocument(b: Uint8Array): typeof DOC_MIMES[number] | null {
  if (sniffCv(b) === 'application/pdf') return 'application/pdf'
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg'
  if ([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((x, i) => b[i] === x)) return 'image/png'
  return null
}

export const allIn = (items: DocItem[]) => items.every(i => !i.required || i.received)

export function documentsEmail(firstName: string, jobTitle: string, items: { label: string, required: boolean }[], url: string, reminder = false): Pick<Email, 'subject' | 'text'> {
  const list = items.map(i => `- ${i.label}${i.required ? '' : ' (optional)'}`).join('\n')
  return {
    subject: reminder ? `Reminder: documents for ${jobTitle}` : `A few documents before you start: ${jobTitle}`,
    text: `Hi ${firstName},\n\n${reminder ? 'A reminder: we still need' : 'Welcome aboard! Before you start, please upload'} these documents:\n\n${list}\n\n${url}\n\nPDF or a photo, up to 10 MB each. Only the hiring team sees them. You can come back to this link any time.`,
  }
}

const companyName = async (db: Pick<Db, 'select'>) => (await db.select({ name: settings.companyName }).from(settings))[0]?.name ?? null

async function byToken(db: Pick<Db, 'select'>, token: string) {
  if (!TOKEN.test(token)) throw new DomainError(404, 'documents_not_found') // never query with junk
  const [row] = await db.select({ req: documentRequests, app: applications, firstName: candidates.firstName, jobTitle: jobs.title })
    .from(documentRequests)
    .innerJoin(applications, eq(applications.id, documentRequests.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(documentRequests.token, token))
  if (!row) throw new DomainError(404, 'documents_not_found')
  return row
}

// ---------- public (by token) ----------

export async function publicDocuments(db: Db, token: string) {
  const { req, app, firstName, jobTitle } = await byToken(db, token)
  return {
    companyName: await companyName(db),
    candidateFirstName: firstName,
    jobTitle,
    open: app.status === 'active',
    documents: req.items.map(i => ({ label: i.label, required: i.required, received: !!i.received, fileName: i.received?.file?.name ?? null })),
  }
}

// Changes one item under the application lock, logs it, and completes the step when that was the last one.
async function change(deps: EngineDeps, requestId: string, index: number, edit: (item: DocItem, at: string) => DocItem, ev: { type: string, actorId?: string, data?: Record<string, unknown> }) {
  const out: Enqueued[] = []
  const t = deps.now?.() ?? new Date()
  const res = await deps.db.transaction(async (tx) => {
    const [r] = await tx.select({ applicationId: documentRequests.applicationId }).from(documentRequests).where(eq(documentRequests.id, requestId))
    const [app] = await tx.select().from(applications).where(eq(applications.id, r!.applicationId)).for('update')
    if (app!.status !== 'active') throw new DomainError(409, 'application_closed')
    const [req] = await tx.select().from(documentRequests).where(eq(documentRequests.id, requestId))
    if (!req!.items[index]) throw new DomainError(422, 'unknown_document')
    const items = req!.items.map((it, i) => (i === index ? edit(it, t.toISOString()) : it))
    await tx.update(documentRequests).set({ items }).where(eq(documentRequests.id, requestId))
    await tx.insert(applicationEvents).values({ applicationId: app!.id, type: ev.type, actorId: ev.actorId ?? null, data: { runId: req!.runId, label: items[index]!.label, ...ev.data } })
    await finishDocuments(tx, deps, app!, req!.runId, items, out)
    return { applicationId: app!.id, allIn: allIn(items) }
  })
  await flush(deps, out, res.applicationId) // the walk on may have queued work and emails
  return { allIn: res.allIn }
}

// The candidate's upload. A new upload replaces the earlier file for that document.
export async function uploadDocument(deps: EngineDeps, bucket: Bucket, token: string, index: number, file: { bytes: Uint8Array, name: string }) {
  const { req, app } = await byToken(deps.db, token)
  if (app.status !== 'active') throw new DomainError(409, 'application_closed')
  if (!req.items[index]) throw new DomainError(422, 'unknown_document')
  if (!file.bytes.length) throw new DomainError(422, 'empty_file')
  if (file.bytes.length > MAX_FILE_BYTES) throw new DomainError(413, 'file_too_large')
  const mime = sniffDocument(file.bytes)
  if (!mime) throw new DomainError(422, 'unsupported_file')
  // write-once key, like CVs
  const key = `jobs/${app.jobId}/${app.id}/documents/${crypto.randomUUID()}`
  const meta = { key, sha256: await sha256Hex(file.bytes as Uint8Array<ArrayBuffer>), size: file.bytes.length, mime, name: file.name.slice(0, 255) || 'document' }
  await bucket.put(key, file.bytes, { httpMetadata: { contentType: mime }, sha256: meta.sha256 })
  let replaced: string | undefined // read under the lock, so a racing upload can't make us delete the live file
  let res: Awaited<ReturnType<typeof change>>
  try {
    res = await change(deps, req.id, index, (it, at) => {
      replaced = it.received?.file?.key
      return { ...it, received: { ...it.received, at, file: meta } }
    }, { type: 'document_uploaded' })
  }
  catch (e) {
    await bucket.delete(key).catch(() => {}) // best effort; an orphan is harmless
    throw e
  }
  // ponytail: items dropped when a new flow version changes the list keep their files; sweep R2 by prefix if that matters.
  if (replaced) await bucket.delete(replaced).catch(() => {}) // after commit, best effort
  return res
}

// ---------- the team ----------

// Ticking off and reminding: managers, or anyone with an open assignment on the step (like the booking link).
async function canAct(db: Db, viewer: Viewer, runId: string) {
  if (atLeastManager(viewer.level)) return true
  const [mine] = await db.select({ runId: taskAssignments.runId }).from(taskAssignments)
    .where(and(eq(taskAssignments.runId, runId), eq(taskAssignments.userId, viewer.userId), isNull(taskAssignments.closedAt)))
  return !!mine
}

async function loadForTeam(db: Db, viewer: Viewer, requestId: string) {
  const [req] = await db.select().from(documentRequests).where(eq(documentRequests.id, requestId))
  if (!req) throw new DomainError(404, 'documents_not_found')
  await assertCanSee(db, viewer, req.applicationId).catch(() => { throw new DomainError(404, 'documents_not_found') })
  return req
}

export async function listDocuments(db: Db, viewer: Viewer, applicationId: string) {
  await assertCanSee(db, viewer, applicationId)
  const rows = await db.select({ req: documentRequests, runStatus: nodeRuns.status }).from(documentRequests)
    .innerJoin(nodeRuns, eq(nodeRuns.id, documentRequests.runId))
    .where(eq(documentRequests.applicationId, applicationId)).orderBy(documentRequests.createdAt)
  return Promise.all(rows.map(async ({ req, runStatus }) => {
    const act = await canAct(db, viewer, req.runId)
    return {
      id: req.id, nodeKey: req.nodeKey, runId: req.runId, runStatus, canAct: act,
      url: act ? `/documents/${req.token}` : null,
      documents: req.items.map(i => ({
        label: i.label, required: i.required,
        received: i.received ? { at: i.received.at, fileName: i.received.file?.name ?? null, by: i.received.by?.name ?? null, note: i.received.note ?? null } : null,
      })),
    }
  }))
}

export async function markReceived(deps: EngineDeps, viewer: Viewer, by: { id: string, name: string }, requestId: string, index: number, note?: string) {
  const req = await loadForTeam(deps.db, viewer, requestId)
  if (!(await canAct(deps.db, viewer, req.runId))) throw new DomainError(404, 'documents_not_found')
  const clean = note?.trim() || undefined
  return change(deps, requestId, index, (it, at) => ({ ...it, received: { ...it.received, at, by, ...(clean && { note: clean }) } }),
    { type: 'document_received', actorId: by.id, data: clean ? { note: clean } : {} })
}

// The file for download: NRIC, bank details. Managers, or whoever holds the step; not every interviewer.
export async function documentFile(db: Db, viewer: Viewer, requestId: string, index: number) {
  const req = await loadForTeam(db, viewer, requestId)
  if (!(await canAct(db, viewer, req.runId))) throw new DomainError(404, 'file_not_found')
  const file = req.items[index]?.received?.file
  if (!file) throw new DomainError(404, 'file_not_found')
  return file
}

// "Send a reminder": one email per request per (UTC) day (the key), so a double click never sends twice.
// queued: false when today's is already in; the event is logged only with the email.
export async function documentsReminder(db: Db, viewer: Viewer, requestId: string, appUrl: string, now: Date) {
  const req = await loadForTeam(db, viewer, requestId)
  if (!(await canAct(db, viewer, req.runId))) throw new DomainError(404, 'documents_not_found')
  const { app, firstName, jobTitle } = await byToken(db, req.token)
  if (app.status !== 'active') throw new DomainError(409, 'application_closed')
  if (allIn(req.items)) throw new DomainError(409, 'documents_all_in')
  const key = `documents-reminder:${req.id}:${now.toISOString().slice(0, 10)}`
  const email = documentsEmail(firstName, jobTitle, req.items.filter(i => !i.received), `${appUrl}/documents/${req.token}`, true)
  const queued = await db.transaction(async (tx) => {
    if (!(await queueEmail(tx, { applicationId: app.id, kind: 'documents_reminder', key, ...email }))) return false
    await tx.insert(applicationEvents).values({ applicationId: app.id, type: 'documents_reminded', actorId: viewer.userId, data: { runId: req.runId } })
    return true
  })
  return { key, queued }
}

// For lists (Hires): per application, the required documents in and asked for. No entry = no Request documents step.
export async function documentsStatus(db: Pick<Db, 'select'>, applicationIds: string[]) {
  const out: Record<string, { received: number, required: number }> = {}
  if (!applicationIds.length) return out
  const rows = await db.select({ applicationId: documentRequests.applicationId, items: documentRequests.items }).from(documentRequests)
    .where(inArray(documentRequests.applicationId, applicationIds))
  for (const r of rows) {
    const s = out[r.applicationId] ??= { received: 0, required: 0 }
    const req = r.items.filter(i => i.required)
    s.required += req.length
    s.received += req.filter(i => i.received).length
  }
  return out
}
