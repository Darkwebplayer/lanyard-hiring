import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REGISTRY } from '../shared/workflow/registry'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { documentFile, documentsReminder, documentsStatus, listDocuments, markReceived, publicDocuments, sniffDocument, uploadDocument } from '../server/domain/documents'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { listTasks } from '../server/domain/tasks'
import type { Email } from '../server/engine/email'
import { type EngineDeps, type Enqueued, executeAutoRun, moveApplication, startApplication } from '../server/engine/engine'
import { createHandlers } from '../server/engine/handlers'
import { testDb } from './db'

const ADMIN = 'admin@example.test'
const PDF = new TextEncoder().encode('%PDF-1.4 nric')
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2])
const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}

describe('request documents', () => {
  let db: Db
  const queue: Enqueued[] = []
  const sent: Email[] = []
  const stored = new Map<string, Uint8Array>()
  const bucket = { put: async (k: string, v: Uint8Array) => { stored.set(k, v) }, delete: async (k: string) => { stored.delete(k) } }
  const deps = (): EngineDeps => ({
    db, adminEmail: ADMIN, enqueue: async (items) => { queue.push(...items) },
    handlers: createHandlers({ bucket: { get: async () => null }, ai: null, sendEmail: async (_k, e) => { sent.push(e) }, replyTo: async () => null, appUrl: 'https://hire.test' }),
  })
  const drain = async () => { while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId) }
  const manager = { userId: 'owner', level: 'manager' as const }
  let jobId: string
  let seq = 0

  async function apply() {
    const [c] = await db.insert(s.candidates).values({ email: `n${++seq}@example.test`, firstName: 'Nurul', lastName: 'Tan' }).returning()
    const [a] = await db.insert(s.applications).values({ jobId, candidateId: c!.id, jobVersionId: (await db.query.jobs.findFirst({ where: eq(s.jobs.id, jobId) }))!.publishedVersionId!, answers: {} }).returning()
    await startApplication(deps(), a!.id)
    await drain()
    const [req] = await db.select().from(s.documentRequests).where(eq(s.documentRequests.applicationId, a!.id))
    return { appId: a!.id, req: req! }
  }
  const latestRun = async (appId: string) => (await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, appId)).orderBy(desc(s.nodeRuns.seq)).limit(1))[0]!

  beforeAll(async () => {
    db = await testDb()
    const [mgr] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
    const [emp] = await db.select().from(s.roles).where(eq(s.roles.name, 'Employee'))
    await db.insert(s.user).values([
      { id: 'owner', email: 'owner@example.test', name: 'Jithin', roleId: mgr!.id },
      { id: 'other', email: 'other@example.test', name: 'Other', roleId: emp!.id },
    ])
    const { job } = await createJob(db, 'owner', { title: 'Forklift driver', description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
    jobId = job.id
    await saveDraft(db, job.id, {
      form: [],
      workflow: {
        nodes: [
          { key: 'start', type: 'application_received', config: {} },
          { key: 'docs', type: 'request_documents', config: {
            documents: [{ label: 'NRIC or work pass', required: true }, { label: 'Forklift licence', required: true }, { label: 'WSQ certificates', required: false }],
            assignees: { users: [], roles: [], job_owner: true }, due_days: 7,
          } },
          { key: 'hired', type: 'end', config: { outcome: 'hired' } },
        ],
        edges: [{ from: 'start', to: 'docs' }, { from: 'docs', to: 'hired' }],
      },
    })
    await publish(db, job.id, ADMIN)
  })
  afterAll(() => db.close())

  it('validates: at least one document, labels not empty', () => {
    const cfg = REGISTRY.request_documents!.config
    const assignees = { users: [], roles: [], job_owner: true }
    expect(cfg.safeParse({ documents: [], assignees }).success).toBe(false)
    expect(cfg.safeParse({ documents: [{ label: '  ', required: true }], assignees }).success).toBe(false)
    expect(cfg.safeParse({ documents: [{ label: 'NRIC', required: true }], assignees: { users: [], roles: [], job_owner: false } }).success).toBe(false)
    expect(cfg.safeParse({ documents: [{ label: 'NRIC' }], assignees }).success).toBe(true)
  })

  it('sniffs PDF, JPG and PNG only', () => {
    expect(sniffDocument(PDF)).toBe('application/pdf')
    expect(sniffDocument(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]))).toBe('image/jpeg')
    expect(sniffDocument(PNG)).toBe('image/png')
    expect(sniffDocument(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull()
  })

  it('emails the link, waits in the inbox, completes on upload + mark received, and the flow moves on', async () => {
    const { appId, req } = await apply()
    expect(req.token).toMatch(/^[\w-]{32}$/)
    expect(sent.at(-1)!.text).toContain(`https://hire.test/documents/${req.token}`)
    expect(sent.at(-1)!.text).toContain('WSQ certificates (optional)')
    expect(await latestRun(appId)).toMatchObject({ nodeKey: 'docs', status: 'waiting_on_human' })
    expect((await listTasks(db, manager, ADMIN, new Date())).mine.map(t => t.nodeType)).toContain('request_documents')

    await rejects(uploadDocument(deps(), bucket, req.token, 0, { bytes: new TextEncoder().encode('MZ exe'), name: 'x.exe' }), 422, 'unsupported_file')
    await rejects(uploadDocument(deps(), bucket, req.token, 0, { bytes: new Uint8Array(10 * 1024 * 1024 + 1).fill(0x25), name: 'big.pdf' }), 413, 'file_too_large')
    await rejects(uploadDocument(deps(), bucket, 'x'.repeat(32), 0, { bytes: PDF, name: 'nric.pdf' }), 404, 'documents_not_found')

    expect(await uploadDocument(deps(), bucket, req.token, 0, { bytes: PDF, name: 'nric.pdf' })).toEqual({ allIn: false })
    expect((await publicDocuments(db, req.token)).documents.map(d => d.received)).toEqual([true, false, false])
    expect(await documentsStatus(db, [appId])).toEqual({ [appId]: { received: 1, required: 2 } })

    // an employee with no task here can neither see nor tick
    await rejects(listDocuments(db, { userId: 'other', level: 'employee' }, appId), 404, 'application_not_found')
    await rejects(markReceived(deps(), { userId: 'other', level: 'employee' }, { id: 'other', name: 'Other' }, req.id, 1), 404, 'documents_not_found')

    expect(await markReceived(deps(), manager, { id: 'owner', name: 'Jithin' }, req.id, 1, 'Seen the original')).toEqual({ allIn: true })
    const app = await db.query.applications.findFirst({ where: eq(s.applications.id, appId) })
    expect(app).toMatchObject({ status: 'closed', outcome: 'hired' }) // docs → Hired
    const [list] = await listDocuments(db, manager, appId)
    expect(list!.documents[1]!.received).toMatchObject({ by: 'Jithin', note: 'Seen the original', fileName: null })
    expect((await documentFile(db, manager, req.id, 0)).name).toBe('nric.pdf')
    expect(stored.has((await documentFile(db, manager, req.id, 0)).key)).toBe(true)

    // closed application: no more files
    await rejects(uploadDocument(deps(), bucket, req.token, 2, { bytes: PNG, name: 'wsq.png' }), 409, 'application_closed')
  })

  it('coming back to the step keeps the link and what came in', async () => {
    const { appId, req } = await apply()
    await uploadDocument(deps(), bucket, req.token, 0, { bytes: PDF, name: 'nric.pdf' })
    await moveApplication(deps(), appId, { node: 'start' }, { reason: 'redo' }, 'owner')
    await drain()
    const [again] = await db.select().from(s.documentRequests).where(eq(s.documentRequests.applicationId, appId))
    expect(again!.token).toBe(req.token)
    expect(again!.runId).not.toBe(req.runId)
    expect(again!.items[0]!.received?.file?.name).toBe('nric.pdf')
    expect(await documentsStatus(db, [appId, crypto.randomUUID()])).toEqual({ [appId]: { received: 1, required: 2 } })
  })

  it('a re-upload deletes the old file; files only for whoever holds the step; one reminder a day', async () => {
    const { appId, req } = await apply()
    await uploadDocument(deps(), bucket, req.token, 0, { bytes: PDF, name: 'old.pdf' })
    const old = (await documentFile(db, manager, req.id, 0)).key
    await uploadDocument(deps(), bucket, req.token, 0, { bytes: PDF, name: 'new.pdf' })
    const now = (await documentFile(db, manager, req.id, 0)).key
    expect(stored.has(old)).toBe(false)
    expect(stored.has(now)).toBe(true)

    // an interviewer who once submitted here can see the application, not download its NRIC
    const other = { userId: 'other', level: 'employee' as const }
    await db.insert(s.taskAssignments).values({ runId: req.runId, userId: 'other', submittedAt: new Date(), closedAt: new Date() })
    expect((await listDocuments(db, other, appId))[0]!.canAct).toBe(false)
    await rejects(documentFile(db, other, req.id, 0), 404, 'file_not_found')
    await db.update(s.taskAssignments).set({ closedAt: null }).where(and(eq(s.taskAssignments.runId, req.runId), eq(s.taskAssignments.userId, 'other')))
    expect((await documentFile(db, other, req.id, 0)).name).toBe('new.pdf')

    const at = new Date('2026-10-25T03:00:00Z')
    expect(await documentsReminder(db, manager, req.id, 'https://hire.test', at)).toMatchObject({ queued: true })
    expect(await documentsReminder(db, manager, req.id, 'https://hire.test', at)).toMatchObject({ queued: false })
    const evs = await db.select().from(s.applicationEvents).where(and(eq(s.applicationEvents.applicationId, appId), eq(s.applicationEvents.type, 'documents_reminded')))
    expect(evs).toHaveLength(1)
  })
})
