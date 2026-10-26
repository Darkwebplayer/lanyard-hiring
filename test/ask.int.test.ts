import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import type { Viewer } from '../server/domain/applications'
import { aiState, askStream, assertAiOn, contextFor, fit } from '../server/domain/ask'
import { DomainError } from '../server/domain/errors'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { type AutoHandler, type EngineDeps, type Enqueued, executeAutoRun, startApplication, submitTask } from '../server/engine/engine'
import type { AppEnv } from '../server/env'
import { testDb } from './db'

// Phase 3 Ask: the AI sees what the page shows, under the page's access rules.

const ADMIN = 'admin@example.test'
const t = new Date('2026-10-20T09:00:00Z')
let db: Db
let role: string
const queue: Enqueued[] = []
const handlers: Record<string, AutoHandler> = {
  cv_parse: async () => ({ output: { text: 'x'.repeat(50_000), skills: ['TypeScript'], years_experience: 6, current_title: 'Engineer', file_sha256: 'x' } }),
  ai_review: async () => ({ output: { skills_match: 90, experience: 62, overall: 76, summary: 'Strong' } }),
  send_email: async () => ({ output: { sent: true } }),
}
const deps = (): EngineDeps => ({ db, handlers, adminEmail: ADMIN, now: () => t, enqueue: async (i) => { queue.push(...i) } })
const owner: Viewer = { userId: 'owner', level: 'manager' }
const emp = (userId: string): Viewer => ({ userId, level: 'employee' })
const ctx = (viewer: Viewer, route: string, params: Record<string, string>, focus?: string) =>
  contextFor(db, viewer, { route, params, focus }, ADMIN, t)
const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}

let jobId: string
let appId: string
let runId: string

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  ;[{ id: role }] = await db.insert(s.roles).values({ name: 'Interviewer', level: 'employee' }).returning() as any
  await db.insert(s.user).values([
    { id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id },
    { id: 'i1', email: 'i1@example.test', name: 'I1', roleId: role },
    { id: 'i2', email: 'i2@example.test', name: 'I2', roleId: role },
    { id: 'outsider', email: 'out@example.test', name: 'Out', roleId: role },
  ])
  // a blind panel of two interviewers; the outsider shares their role but holds no task (added after assignment)
  await db.update(s.user).set({ roleId: null }).where(eq(s.user.id, 'outsider'))
  const tpl = structuredClone(STANDARD_HIRE)
  tpl.form.push({ key: 'gender', label: 'Gender', type: 'string', required: false, protected: true })
  const node = tpl.workflow.nodes.find(n => n.key === 'interview')!
  node.config = { ...(node.config as object), assignees: { users: [], roles: [role], job_owner: false }, min_submissions: 2 }
  const { job } = await createJob(db, 'owner', { title: 'Barista', description: '', requirements: {}, openings: 1, closesAt: null }, { kind: 'blank' })
  await saveDraft(db, job.id, tpl)
  await publish(db, job.id, ADMIN)
  jobId = job.id
  const published = (await db.query.jobs.findFirst({ where: eq(s.jobs.id, job.id) }))!
  const [c] = await db.insert(s.candidates).values({ email: 'ben@example.test', firstName: 'Ben', lastName: 'Okafor' }).returning()
  const [a] = await db.insert(s.applications).values({
    jobId, candidateId: c!.id, jobVersionId: published.publishedVersionId!,
    answers: { cv: { key: 'k', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' }, gender: 'nonbinary-PROTECTED' },
  }).returning()
  appId = a!.id
  await startApplication(deps(), appId)
  while (queue.length) await executeAutoRun(deps(), queue.shift()!.runId)
  runId = (await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.applicationId, appId)).orderBy(desc(s.nodeRuns.seq)).limit(1))[0]!.id
  await submitTask(deps(), runId, 'i1', { technical: 4, communication: 3, hire: true, notes: 'I1-SECRET-NOTE' })
})
afterAll(() => db.close())

describe('access (security)', () => {
  it('an employee on a blind panel gets no other scorecards and no protected answers', async () => {
    for (const [route, params] of [['candidates-id', { id: appId }], ['inbox-runId', { runId }]] as const) {
      const c = await ctx(emp('i2'), route, params)
      const json = JSON.stringify(c.data)
      expect(json).not.toContain('I1-SECRET-NOTE')
      expect(json).not.toContain('PROTECTED')
      expect(json).not.toContain('gender')
      expect(json).not.toContain('"output"') // no run data (AI scores, CV text) for employees
      expect(c.anchors.map(a => a.id)).not.toContain('field:gender')
      expect(c.scope).toBe('task')
      expect(c.label).toBe('Ben Okafor · Barista')
    }
    // the manager sees both
    const json = JSON.stringify((await ctx(owner, 'candidates-id', { id: appId })).data)
    expect(json).toContain('I1-SECRET-NOTE')
    expect(json).toContain('PROTECTED')
  })

  it('anyone without a task, and employees on manager pages, get 404 not_found', async () => {
    await rejects(ctx(emp('outsider'), 'candidates-id', { id: appId }), 404, 'not_found')
    await rejects(ctx(emp('outsider'), 'tasks-runId', { runId }), 404, 'not_found')
    for (const route of ['jobs-id', 'jobs-id-flow', 'jobs-id-details']) await rejects(ctx(emp('i2'), route, { id: jobId }), 404, 'not_found')
    for (const route of ['hires', 'jobs']) await rejects(ctx(emp('i2'), route, {}), 404, 'not_found')
    await rejects(ctx(owner, 'candidates-id', { id: 'not-a-uuid' }), 404, 'not_found')
    await rejects(ctx(owner, 'candidates-id', { id: crypto.randomUUID() }), 404, 'not_found')
  })
})

describe('context', () => {
  it('candidate: capped, anchors from the data, suggestions from the scores', async () => {
    const c = await ctx(owner, 'candidates-id', { id: appId })
    expect(JSON.stringify(c.data).length).toBeLessThanOrEqual(30_000)
    expect(JSON.stringify(c.data)).not.toContain('x'.repeat(3001)) // CV text cut
    expect(c).toMatchObject({ initials: 'BO', scope: 'all', placeholder: 'Ask about Ben Okafor' })
    const ids = c.anchors.map(a => a.id)
    expect(ids).toEqual(expect.arrayContaining(['node:ai', 'node:interview', 'stage:screening', 'field:cv', 'field:gender']))
    const keys = new Set([...STANDARD_HIRE.workflow.nodes.map(n => `node:${n.key}`), ...STANDARD_HIRE.workflow.stages!.map(st => `stage:${st.id}`), 'field:cv', 'field:linkedin', 'field:notice_period_weeks', 'field:gender'])
    expect(ids.every(id => keys.has(id))).toBe(true)
    expect(c.suggestions.length).toBeLessThanOrEqual(3)
    expect(c.suggestions[0]).toBe('Why 62 on experience?')
  })

  it('focus marks pointing_at and relabels the chip', async () => {
    const c = await ctx(owner, 'candidates-id', { id: appId }, 'node:ai')
    expect(c.label).toBe('AI screening step · Barista')
    expect(c.data!.pointing_at).toMatchObject({ id: 'node:ai', label: 'AI screening', step: { key: 'ai' }, runs: [{ step: 'ai', output: { experience: 62 } }] })
    const p = await ctx(owner, 'jobs-id', { id: jobId }, 'stage:interview')
    expect(p.label).toBe('Interview stage · Barista')
    expect(p.data!.pointing_at).toMatchObject({ id: 'stage:interview', people: [{ name: 'Ben Okafor' }] })
    // a focus that isn't on the page is ignored
    expect((await ctx(owner, 'candidates-id', { id: appId }, 'node:nope')).data).not.toHaveProperty('pointing_at')
  })

  it('pipeline, flow, task and unknown pages', async () => {
    const p = await ctx(owner, 'jobs-id', { id: jobId })
    expect(p.label).toBe('Pipeline · Barista')
    expect(p.suggestions).toContain('Who has waited longest?')
    const f = await ctx(owner, 'jobs-id-flow', { id: jobId })
    expect(f.suggestions[0]).toBe('What happens if someone fails Screen?')
    const lib = await ctx(owner, 'library-flows-id', { id: 'standard' })
    expect(lib.label).toBe('Standard hire · Workflow template')
    const task = await ctx(emp('i2'), 'inbox-runId', { runId })
    expect(task.suggestions[0]).toBe('What should I ask Ben?')
    const other = await ctx(emp('i2'), 'settings', {})
    expect(other).toMatchObject({ label: 'Settings', data: null, anchors: [], suggestions: [] })
  })

  it('fit cuts long strings, then long lists, under the cap', () => {
    const big = { events: Array.from({ length: 2000 }, (_, i) => ({ i, note: 'y'.repeat(200) })) }
    expect(JSON.stringify(fit(big)).length).toBeLessThanOrEqual(30_000)
  })
})

describe('gate and stream', () => {
  const env = (e: Partial<AppEnv>) => e as AppEnv
  it('me.ai: unconfigured without a key (unless mocked), off when an admin turned it off', async () => {
    expect(aiState(env({}), true)).toBe('unconfigured')
    expect(aiState(env({ GEMINI_API_KEY: 'k' }), false)).toBe('off')
    expect(aiState(env({ GEMINI_API_KEY: 'k' }), true)).toBe('on')
    expect(aiState(env({ AI_MOCK: '1' }), true)).toBe('on')
    await rejects(assertAiOn(db, env({})), 503, 'ai_not_configured')
    await db.update(s.settings).set({ aiEnabled: false })
    await rejects(assertAiOn(db, env({ GEMINI_API_KEY: 'k' })), 409, 'ai_off')
  })

  it('AI_MOCK streams a canned answer naming the page and citing a real anchor', async () => {
    const c = await ctx(owner, 'candidates-id', { id: appId })
    const res = await askStream(env({ AI_MOCK: '1' }), c, 'Why?', [])
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const text = await res.text()
    expect(text).toContain('Ben Okafor · Barista')
    expect(text).toContain(`(#${c.anchors[0]!.id})`)
  })
})
