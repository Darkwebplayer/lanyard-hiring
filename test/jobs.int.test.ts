import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Graph } from '../shared/workflow/types'
import * as s from '../server/db/schema'
import { DomainError } from '../server/domain/errors'
import { createJob, getJob, pickerFields, publish, saveDraft, updateJob, validateDraft } from '../server/domain/jobs'
import { testDb } from './db'

let db: Awaited<ReturnType<typeof testDb>>
const ADMIN = 'admin@example.test'
let ownerId: string
let interviewerRole: string

const input = { title: 'Backend Engineer', description: '', requirements: { min_experience_years: 3 }, openings: 2, closesAt: null }
const rejects = async (p: Promise<unknown>, status: number, message?: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect((e as DomainError).status).toBe(status)
  if (message) expect((e as DomainError).message).toBe(message)
  return e as DomainError
}
const withInterview = (patch: Record<string, unknown>) => {
  const t = structuredClone(STANDARD_HIRE)
  const n = t.workflow.nodes.find(n => n.key === 'interview')!
  n.config = { ...(n.config as object), ...patch }
  return t
}

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  ;[{ id: interviewerRole }] = await db.insert(s.roles).values({ name: 'Interviewer', level: 'employee' }).returning() as any
  await db.insert(s.user).values([
    { id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id },
    { id: 'int1', email: 'int1@example.test', name: 'I1', roleId: interviewerRole },
    { id: 'int2', email: 'int2@example.test', name: 'I2', roleId: interviewerRole },
    { id: 'gone', email: 'gone@example.test', name: 'Gone', roleId: interviewerRole, active: false },
  ])
  ownerId = 'owner'
})
afterAll(() => db.close())

describe('jobs and versions', () => {
  it('create from template → validate → publish → edit opens v2 → publish v2; v1 stays frozen', async () => {
    const { job, draft } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    expect(draft.version).toBe(1)
    expect(await validateDraft(db, job.id, ADMIN)).toEqual([])

    const v1 = await publish(db, job.id, ADMIN)
    let state = await getJob(db, job.id)
    expect(state.job).toMatchObject({ status: 'open', publishedVersionId: v1.id })
    expect(state.draft).toBeNull()

    const edited = structuredClone(STANDARD_HIRE)
    ;(edited.workflow.nodes.find(n => n.key === 'offer_email')!.config as any).subject = 'Offer: {{job.title}}'
    const v2draft = await saveDraft(db, job.id, edited)
    expect(v2draft.version).toBe(2)
    await saveDraft(db, job.id, edited) // second save updates the same draft
    expect((await db.select().from(s.jobVersions).where(eq(s.jobVersions.jobId, job.id)))).toHaveLength(2)

    const v2 = await publish(db, job.id, ADMIN)
    await rejects(publish(db, job.id, ADMIN), 409, 'no_draft')
    state = await getJob(db, job.id)
    expect(state.job.publishedVersionId).toBe(v2.id)
    const frozen = await db.query.jobVersions.findFirst({ where: eq(s.jobVersions.id, v1.id) })
    expect((frozen!.workflow as Graph).nodes.find(n => n.key === 'offer_email')!.config).toMatchObject({ subject: 'Your offer for {{job.title}}' })
  })

  it('an invalid draft is kept, and publish returns its issues', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'blank' })
    const e = await rejects(publish(db, job.id, ADMIN), 422, 'invalid_version')
    expect(e.issues!.length).toBeGreaterThan(0)
    expect((await getJob(db, job.id)).draft).not.toBeNull()
  })

  it('keys keep their type across versions', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    await publish(db, job.id, ADMIN)
    const t = structuredClone(STANDARD_HIRE)
    t.form.find(f => f.key === 'linkedin')!.type = 'number'
    await saveDraft(db, job.id, t)
    expect((await validateDraft(db, job.id, ADMIN)).map(i => i.code)).toEqual(['field_type_changed'])
  })

  it('a key that was dropped cannot come back with another type, including node outputs', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    await publish(db, job.id, ADMIN) // v1: linkedin is a string
    const v2 = structuredClone(STANDARD_HIRE)
    v2.form = v2.form.filter(f => f.key !== 'linkedin')
    await saveDraft(db, job.id, v2)
    await publish(db, job.id, ADMIN)
    const v3 = structuredClone(STANDARD_HIRE)
    v3.form.find(f => f.key === 'linkedin')!.type = 'number'
    const card = (v3.workflow.nodes.find(n => n.key === 'interview')!.config as any).scorecard
    card.find((f: any) => f.key === 'notes').type = 'number' // nodes.interview.notes was text
    await saveDraft(db, job.id, v3)
    expect((await validateDraft(db, job.id, ADMIN)).map(i => i.code).sort()).toEqual(['field_type_changed', 'node_type_changed'])
  })

  it('status transitions: archived is final, open needs a publish', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    await rejects(updateJob(db, job.id, { status: 'open' }), 409, 'publish_first')
    await rejects(updateJob(db, job.id, { status: 'closed' }), 409)
    await publish(db, job.id, ADMIN)
    expect((await updateJob(db, job.id, { status: 'closed' })).status).toBe('closed')
    expect((await updateJob(db, job.id, { status: 'open' })).status).toBe('open')
    await updateJob(db, job.id, { status: 'archived' })
    await rejects(updateJob(db, job.id, { title: 'x' }), 409, 'job_archived')
  })

  it('requirements are frozen into the version at publish', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    const v1 = await publish(db, job.id, ADMIN)
    await updateJob(db, job.id, { requirements: { min_experience_years: 10 } })
    expect(v1.requirements).toEqual({ min_experience_years: 3 })
    expect((await db.query.jobVersions.findFirst({ where: eq(s.jobVersions.id, v1.id) }))!.requirements).toEqual({ min_experience_years: 3 })
  })

  it('assignees must exist, and a panel needs enough people', async () => {
    const check = async (patch: Record<string, unknown>) => {
      const t = withInterview(patch)
      const { job } = await createJob(db, ownerId, input, { kind: 'blank' })
      await saveDraft(db, job.id, t)
      return (await validateDraft(db, job.id, ADMIN)).map(i => i.code)
    }
    expect(await check({ assignees: { users: ['ghost', 'gone'], roles: [], job_owner: false } })).toEqual(['bad_assignee', 'bad_assignee', 'not_enough_assignees'])
    expect(await check({ assignees: { users: [], roles: [], job_owner: true }, min_submissions: 2 })).toEqual(['not_enough_assignees'])
    // the role has two active members (the inactive one doesn't count)
    expect(await check({ assignees: { users: [], roles: [interviewerRole], job_owner: false }, min_submissions: 2 })).toEqual([])
    expect(await check({ assignees: { users: [], roles: [interviewerRole], job_owner: false }, min_submissions: 3 })).toEqual(['not_enough_assignees'])
    expect(await check({ assignees: { users: [], roles: [crypto.randomUUID()], job_owner: true } })).toEqual(['bad_role'])
  })

  it('duplicate to another job copies the latest version', async () => {
    const { job: src } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    const { draft } = await createJob(db, ownerId, { ...input, title: 'Copy' }, { kind: 'job', jobId: src.id })
    expect(draft.workflow).toEqual(STANDARD_HIRE.workflow)
    await rejects(createJob(db, ownerId, input, { kind: 'job', jobId: crypto.randomUUID() }), 404, 'source_job_not_found')
  })

  // PGlite runs transactions one at a time, so only `pnpm test:pg` really races these
  it('[race] concurrent saves on a published job open exactly one draft', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    await publish(db, job.id, ADMIN)
    await Promise.all([saveDraft(db, job.id, STANDARD_HIRE), saveDraft(db, job.id, STANDARD_HIRE), saveDraft(db, job.id, STANDARD_HIRE)])
    const drafts = await db.select().from(s.jobVersions).where(and(eq(s.jobVersions.jobId, job.id), eq(s.jobVersions.status, 'draft')))
    expect(drafts.map(d => d.version)).toEqual([2])
  })

  it('archived jobs refuse drafts and publishes', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    await db.update(s.jobs).set({ status: 'archived' }).where(eq(s.jobs.id, job.id))
    await rejects(saveDraft(db, job.id, STANDARD_HIRE), 409, 'job_archived')
    await rejects(publish(db, job.id, ADMIN), 409, 'job_archived')
  })

  it('variable picker reads the draft', async () => {
    const { job } = await createJob(db, ownerId, input, { kind: 'standard_hire' })
    const paths = (await pickerFields(db, job.id, 'decision')).map(f => f.path)
    expect(paths).toEqual(expect.arrayContaining(['nodes.interview.hire', 'job.min_experience_years']))
    await rejects(pickerFields(db, job.id, 'nope'), 404, 'node_not_found')
  })
})
