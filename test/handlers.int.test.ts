import { readFileSync } from 'node:fs'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Context, FormField } from '../shared/workflow/types'
import type { Db } from '../server/db/client'
import * as s from '../server/db/schema'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { type Ai, cloudflareAi, mockAi } from '../server/engine/ai'
import { EmailError, type Email } from '../server/engine/email'
import { type AutoHandlerArgs, type Enqueued, executeAutoRun, HandlerError, startApplication } from '../server/engine/engine'
import { sha256Hex } from '../server/engine/handlers/extract'
import { aiReviewInput, createHandlers, type HandlerDeps } from '../server/engine/handlers'
import { testDb } from './db'

const pdf = new Uint8Array(readFileSync(new URL('./fixtures/cv.pdf', import.meta.url)))
const ctx = (over: Partial<Context> = {}): Context => ({
  candidate: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.test', phone: '123' },
  form: {},
  job: { title: 'Backend Engineer', openings: 2, must_have_skills: ['TypeScript', 'Postgres'], min_experience_years: 3 },
  nodes: {},
  ...over,
})
const args = (over: Partial<AutoHandlerArgs>): AutoHandlerArgs =>
  ({ run: { id: 'run-1' } as any, node: {} as any, config: {}, ctx: ctx(), form: [], application: {} as any, ...over })

let store: Map<string, Uint8Array>
let mail: { key: string, email: Email }[]
let deps: HandlerDeps
const handlers = () => createHandlers(deps)
const failsWith = async (p: Promise<unknown>, code: string, retryable: boolean) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(HandlerError)
  expect(e).toMatchObject({ code, retryable })
}

beforeEach(() => {
  store = new Map()
  mail = []
  deps = {
    bucket: { get: async k => store.has(k) ? { arrayBuffer: async () => store.get(k)!.slice().buffer } : null },
    ai: mockAi,
    sendEmail: async (key, email) => { mail.push({ key, email }) },
    replyTo: async () => 'recruiting@example.test',
  }
})

const fileMeta = async (bytes: Uint8Array, key = 'jobs/j/a/cv') => {
  store.set(key, bytes)
  return { key, sha256: await sha256Hex(bytes), size: bytes.length, mime: 'application/pdf', name: 'cv.pdf' }
}

describe('cv_parse', () => {
  it('reads the stored file, checks its hash, extracts text and facts', async () => {
    const meta = await fileMeta(pdf)
    const { output } = await handlers().cv_parse!(args({ config: { file_field: 'cv' }, ctx: ctx({ form: { cv: meta } }) }))
    expect(output).toMatchObject({ skills: ['typescript', 'postgres', 'cloudflare'], years_experience: 6, current_title: 'Senior Backend Engineer', file_sha256: meta.sha256 })
    expect(output.text).toContain('6 years experience')
  })

  it('fails without retry on a missing, tampered or textless file', async () => {
    const h = handlers().cv_parse!
    await failsWith(h(args({ config: { file_field: 'cv' } })), 'missing_file', false)
    const meta = await fileMeta(pdf)
    await failsWith(h(args({ config: { file_field: 'cv' }, ctx: ctx({ form: { cv: { ...meta, key: 'gone' } } }) })), 'file_not_found', false)
    await failsWith(h(args({ config: { file_field: 'cv' }, ctx: ctx({ form: { cv: { ...meta, sha256: 'b'.repeat(64) } } }) })), 'checksum_mismatch', false)
    const blank = await fileMeta(new TextEncoder().encode('%PDF-1.3 not really'), 'blank')
    await failsWith(h(args({ config: { file_field: 'cv' }, ctx: ctx({ form: { cv: blank } }) })), 'unreadable_cv', false)
  })

  it('without AI configured it fails visibly instead of guessing', async () => {
    deps.ai = null
    const meta = await fileMeta(pdf)
    await failsWith(handlers().cv_parse!(args({ config: { file_field: 'cv' }, ctx: ctx({ form: { cv: meta } }) })), 'ai_not_configured', false)
  })

  it('with AI turned off in Settings it stops without retry', async () => {
    deps.aiEnabled = async () => false
    const meta = await fileMeta(pdf)
    await failsWith(handlers().cv_parse!(args({ config: { file_field: 'cv' }, ctx: ctx({ form: { cv: meta } }) })), 'ai_off', false)
  })
})

describe('ai_review', () => {
  const form: FormField[] = [
    { key: 'cv', label: 'CV', type: 'file', required: true },
    { key: 'notice', label: 'Notice period', type: 'number', required: false },
    { key: 'gender', label: 'Gender', type: 'string', required: false, protected: true },
  ]
  const config = { criteria: [{ key: 'skills', label: 'Skills', description: '' }, { key: 'exp', label: 'Experience', description: '' }], cv_text_ref: 'nodes.cv.text' }
  const c = ctx({ form: { cv: { key: 'k' }, notice: 4, gender: 'female' }, nodes: { cv: { text: 'TypeScript only' } } })

  it('sends only job, non-protected non-file answers and CV text — never who the candidate is', () => {
    const input = aiReviewInput(c, form, config.cv_text_ref)
    expect(input).toEqual({
      job: { title: 'Backend Engineer', requirements: { must_have_skills: ['TypeScript', 'Postgres'], min_experience_years: 3 } },
      answers: [{ label: 'Notice period', value: 4 }],
      cv_text: 'TypeScript only',
    })
    const json = JSON.stringify(input)
    for (const leak of ['Jane', 'Doe', 'jane@example.test', '123', 'female', '"k"']) expect(json).not.toContain(leak)
  })

  it('review round 2: identity is redacted from CV text; refs outside form/CV text are ignored', () => {
    const cv = 'Jane Doe\njane@example.test | +44 7700 900123 | 123\nJanet Smith, 2015 - 2020 at Doe Corp? no: DoeCorp\nContact: other.person@mail.example'
    const input = aiReviewInput(ctx({ nodes: { cv: { text: cv } } }), form, 'nodes.cv.text')
    expect(input.cv_text).toBe('[redacted] [redacted]\n[email] | [phone] | [redacted]\nJanet Smith, 2015 - 2020 at [redacted] Corp? no: DoeCorp\nContact: [email]')
    for (const ref of ['candidate.email', 'job.title', 'form.gender', 'nodes.cv']) expect(aiReviewInput(c, form, ref).cv_text).toBeUndefined()
  })

  it('review round 2: the audit hash covers the criteria and instructions actually sent', async () => {
    const a = await handlers().ai_review!(args({ config, ctx: c, form }))
    const b = await handlers().ai_review!(args({ config: { ...config, instructions: 'Prefer Rust' }, ctx: c, form }))
    expect(a.input).not.toEqual(b.input)
  })

  it('scores per criterion, overall is their mean, and the audit records model and input hash', async () => {
    const { output, input } = await handlers().ai_review!(args({ config, ctx: c, form }))
    expect(output).toMatchObject({ skills: 50, exp: 50, overall: 50 })
    expect(input).toMatchObject({ model: 'mock', prompt_version: 'v3', input_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), sure: { skills: 0.5, exp: 0.5 } })
    expect(output).not.toHaveProperty('sure')
    const again = await handlers().ai_review!(args({ config, ctx: c, form }))
    expect(again.input).toEqual(input) // same input, same hash
  })

  it('provider errors propagate so the engine retries them', async () => {
    deps.ai = { ...mockAi, review: async () => { throw new Error('503') } } satisfies Ai
    await expect(handlers().ai_review!(args({ config, ctx: c, form }))).rejects.toThrow('503')
  })
})

describe('ai_check', () => {
  const config = {
    questions: [
      { key: 'weekends', label: 'Weekends', question: 'Can they work weekends?', kind: 'yes_no' },
      { key: 'role', label: 'Role', question: 'Which role fits best?', kind: 'choice', options: [{ key: 'barista', label: 'Barista' }, { key: 'kitchen', label: 'Kitchen' }] },
    ],
  }

  it('outputs one answer per question; the audit records model, hash and how sure', async () => {
    const { output, input } = await handlers().ai_check!(args({ config }))
    expect(output).toEqual({ weekends: true, role: 'barista' })
    expect(input).toMatchObject({ model: 'mock', prompt_version: 'v3', input_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), sure: { weekends: 0.5, role: 0.5 } })
  })

  it('without AI configured it fails visibly', async () => {
    deps.ai = null
    await failsWith(handlers().ai_check!(args({ config })), 'ai_not_configured', false)
  })
})

describe('cloudflareAi (fake binding)', () => {
  const input = { job: { title: 'Barista', requirements: {} }, answers: [], cv_text: 'x'.repeat(40_000) }
  const fake = (answers: object) => {
    const calls: { model: string, body: any }[] = []
    return { calls, binding: { run: async (model: string, body: any) => { calls.push({ model, body }); return { answers } } } as any }
  }
  const failing = async () => { throw new Error('gemini 503') }

  it('review: level index → 0–100, confidence → sure; a failed summary keeps the scores', async () => {
    const { binding, calls } = fake({
      coffee: { type: 'score', score: 2, confidence: 0.6 },
      hygiene: { type: 'score', score: 4, confidence: 0.9 },
    })
    const criteria = [{ key: 'coffee', label: 'Coffee', description: 'Espresso experience' }, { key: 'hygiene', label: 'Hygiene', description: '' }]
    expect(await cloudflareAi(binding, failing).review(input, criteria, 'Weekend cover matters'))
      .toEqual({ scores: { coffee: 50, hygiene: 100 }, sure: { coffee: 0.6, hygiene: 0.9 }, summary: '' })
    expect(calls[0]!.model).toBe('@cf/cloudflare/clef-flash')
    expect(calls[0]!.body.questions.coffee).toMatchObject({ type: 'score', instructions: 'Coffee: Espresso experience\nWeekend cover matters' })
    expect(calls[0]!.body.questions.coffee.criteria).toHaveLength(5)
    expect(JSON.parse(calls[0]!.body.state).cv_text).toHaveLength(30_000)
  })

  it('check: noul → boolean with sure max(p, 1-p); choice → option key', async () => {
    const { binding, calls } = fake({
      weekends: { type: 'noul', noul: 0.3 },
      role: { type: 'choice', choice: 'kitchen', probabilities: { barista: 0.2, kitchen: 0.8 }, confidence: 0.7 },
    })
    const out = await cloudflareAi(binding).check(input, [
      { key: 'weekends', label: 'W', question: 'Weekends?', kind: 'yes_no' },
      { key: 'role', label: 'R', question: 'Role?', kind: 'choice', options: [{ key: 'barista', label: 'Barista' }, { key: 'kitchen', label: 'Kitchen' }] },
    ])
    expect(out).toEqual({ answers: { weekends: false, role: 'kitchen' }, sure: { weekends: 0.7, role: 0.8 } })
    expect(calls[0]!.body.questions.role).toEqual({ type: 'choice', instructions: 'Role?', criteria: { barista: 'Barista', kitchen: 'Kitchen' } })
  })

  it('parseCv: one Clairic call with the extra fields; values come back, null when not stated', async () => {
    const { binding, calls } = fake({
      current_title: { type: 'text', value: 'Barista' },
      years_experience: { type: 'duration', value: 1.5 },
      skills: { type: 'list', value: ['espresso'], confidence: 0.29 },
      notice: { type: 'number', value: null, p_null: 0.9 },
      towns: { type: 'list', value: ['Leeds'] },
    })
    const out = await cloudflareAi(binding).parseCv('y'.repeat(40_000), [
      { key: 'notice', label: 'Notice period in weeks', type: 'number' },
      { key: 'towns', label: 'Towns', type: 'list', hint: 'Where they have worked' },
    ])
    expect(out).toEqual({ current_title: 'Barista', years_experience: 1.5, skills: ['espresso'], notice: null, towns: ['Leeds'] })
    expect(calls[0]!.model).toBe('@cf/cloudflare/clairic')
    expect(calls[0]!.body.state).toHaveLength(30_000)
    expect(calls[0]!.body.fields.towns).toEqual({ type: 'list', items: 'text', instructions: 'Towns: Where they have worked' })
    expect(calls[0]!.body.fields.notice).toEqual({ type: 'number', instructions: 'Notice period in weeks' })
  })
})

describe('send_email', () => {
  it('renders strictly, sends to the candidate with reply-to, keyed by run id', async () => {
    await handlers().send_email!(args({ config: { subject: 'Re {{job.title}}', body: 'Hi {{candidate.first_name}}' } }))
    expect(mail).toEqual([{ key: 'run-1', email: { to: 'jane@example.test', subject: 'Re Backend Engineer', text: 'Hi Jane', replyTo: 'recruiting@example.test' } }])
  })

  it('a missing ref fails without sending; provider errors keep their retryability', async () => {
    await failsWith(handlers().send_email!(args({ config: { subject: 'x', body: 'Score {{nodes.interview.score}}' } })), 'missing_ref', false)
    expect(mail).toEqual([])
    deps.sendEmail = async () => { throw new EmailError('429', true) }
    await failsWith(handlers().send_email!(args({ config: { subject: 'x', body: 'y' } })), 'email_failed', true)
  })
})

describe('end to end with real handlers (mock AI, fake bucket)', () => {
  let db: Db
  beforeAll(async () => {
    db = await testDb()
    const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
    await db.insert(s.user).values({ id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id })
  })
  afterAll(() => db.close())

  it('CV upload → parse → review → shortlist → interview → offer email', async () => {
    const tpl = structuredClone(STANDARD_HIRE)
    const { job } = await createJob(db, 'owner', { title: 'Backend Engineer', description: '', requirements: { must_have_skills: ['TypeScript', 'Postgres'] }, openings: 1, closesAt: null }, { kind: 'blank' })
    await saveDraft(db, job.id, tpl)
    const version = await publish(db, job.id, 'admin@example.test')
    const [c] = await db.insert(s.candidates).values({ email: 'jane@example.test', firstName: 'Jane', lastName: 'Doe' }).returning()
    const [a] = await db.insert(s.applications).values({ jobId: job.id, candidateId: c!.id, jobVersionId: version.id, answers: { cv: await fileMeta(pdf) } }).returning()

    const queue: Enqueued[] = []
    const engine = { db, handlers: handlers(), adminEmail: 'admin@example.test', enqueue: async (i: Enqueued[]) => { queue.push(...i) } }
    await startApplication(engine, a!.id)
    while (queue.length) await executeAutoRun(engine, queue.shift()!.runId)

    const [ai] = await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.nodeKey, 'ai')).orderBy(desc(s.nodeRuns.seq)).limit(1)
    expect(ai!.output).toMatchObject({ overall: 100 }) // both must-have skills are in the CV
    const [task] = await db.select().from(s.nodeRuns).where(eq(s.nodeRuns.status, 'waiting_on_human'))
    expect(task!.nodeKey).toBe('interview')
  })
})
