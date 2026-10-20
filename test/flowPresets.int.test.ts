import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withoutNamedPeople } from '../shared/workflow/flowPresets'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import * as s from '../server/db/schema'
import { DomainError } from '../server/domain/errors'
import { createFlowPreset, deleteFlowPreset, flowPresetInput, flowPresetPatch, listFlowPresets, updateFlowPreset } from '../server/domain/flowPresets'
import { createJob, getJob, publish, saveDraft, validateDraft } from '../server/domain/jobs'
import { testDb } from './db'

let db: Awaited<ReturnType<typeof testDb>>
const ADMIN = 'admin@example.test'
const job = { title: 'Data Analyst', description: '', requirements: {}, openings: 1, closesAt: null }
const MISSING = '00000000-0000-4000-8000-000000000000'

const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}
// Standard hire with its interview assigned the way the test needs
const withInterview = (patch: Record<string, unknown>) => {
  const t = structuredClone(STANDARD_HIRE)
  const n = t.workflow.nodes.find(n => n.key === 'interview')!
  n.config = { ...(n.config as object), ...patch }
  return t
}
const add = (name: string, flow: { form: unknown[], workflow: unknown }) => createFlowPreset(db, flowPresetInput.parse({ name, ...flow }))
const codes = async (jobId: string) => (await validateDraft(db, jobId, ADMIN)).map(i => i.code)

beforeAll(async () => {
  db = await testDb()
  const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
  await db.insert(s.user).values([
    { id: 'owner', email: 'owner@example.test', name: 'Owner', roleId: manager!.id },
    { id: 'gone', email: 'gone@example.test', name: 'Gone', roleId: manager!.id, active: false },
  ])
})
afterAll(() => db.close())

describe('flow presets', () => {
  it('saves like a draft: half-built forms are kept, a malformed graph is refused; lists by name, edits, deletes', async () => {
    const half = structuredClone(STANDARD_HIRE)
    half.form[0]!.label = ''
    const b = await add('Engineering loop', half)
    const a = await add('Agency hire', STANDARD_HIRE)
    expect(b.form).toEqual(half.form)
    expect(() => flowPresetInput.parse({ name: 'Broken', form: [], workflow: { nodes: 'x', edges: [] } })).toThrow()
    expect(() => flowPresetInput.parse({ name: ' ', ...STANDARD_HIRE })).toThrow()
    expect((await listFlowPresets(db)).map(p => p.name)).toEqual(['Agency hire', 'Engineering loop'])

    // a patch renames, or replaces form and flow together; never one half
    expect(() => flowPresetPatch.parse({ form: [] })).toThrow()
    expect(() => flowPresetPatch.parse({})).toThrow()
    expect(await updateFlowPreset(db, a.id, flowPresetPatch.parse({ name: 'Agency hire (EU)', description: 'Through our agency' }))).toMatchObject({ name: 'Agency hire (EU)', description: 'Through our agency' })
    expect(await updateFlowPreset(db, a.id, flowPresetPatch.parse({ name: 'Agency hire (EU)' }))).toMatchObject({ description: 'Through our agency' })
    const replaced = await updateFlowPreset(db, a.id, flowPresetPatch.parse({ form: [], workflow: half.workflow }))
    expect(replaced).toMatchObject({ name: 'Agency hire (EU)', form: [] })

    await deleteFlowPreset(db, a.id)
    await rejects(deleteFlowPreset(db, a.id), 404, 'flow_preset_not_found')
    await rejects(updateFlowPreset(db, a.id, { name: 'x' }), 404, 'flow_preset_not_found')
  })

  it('a new job copies a preset independently; an unknown preset is a 404', async () => {
    const p = await add('Copy source', STANDARD_HIRE)
    const { draft } = await createJob(db, 'owner', job, { kind: 'preset', presetId: p.id })
    expect(draft.workflow).toEqual(STANDARD_HIRE.workflow)
    await updateFlowPreset(db, p.id, { form: [], workflow: { nodes: [], edges: [] } })
    expect((await getJob(db, draft.jobId)).draft!.form).toEqual(STANDARD_HIRE.form) // the job kept its copy
    await rejects(createJob(db, 'owner', job, { kind: 'preset', presetId: MISSING }), 404, 'flow_preset_not_found')
  })

  it('catches the leftovers of the job a preset was saved from', async () => {
    const named = withInterview({ assignees: { users: ['gone'], roles: [], job_owner: false } })
    const p = await add('Named people', named)
    const fromNamed = await createJob(db, 'owner', job, { kind: 'preset', presetId: p.id })
    expect(await codes(fromNamed.job.id)).toEqual(['bad_assignee', 'not_enough_assignees'])

    const clean = await add('Swapped', { form: named.form, workflow: withoutNamedPeople(named.workflow) })
    const fromClean = await createJob(db, 'owner', job, { kind: 'preset', presetId: clean.id })
    expect(await codes(fromClean.job.id)).toEqual([])

    const panel = await add('Panel', withInterview({ min_submissions: 2 }))
    const fromPanel = await createJob(db, 'owner', job, { kind: 'preset', presetId: panel.id })
    expect(await codes(fromPanel.job.id)).toEqual(['not_enough_assignees'])
  })

  it('loading a preset into a published job’s draft keeps the live version; a clashing key blocks publish', async () => {
    const { job: j } = await createJob(db, 'owner', job, { kind: 'standard_hire' })
    const live = await publish(db, j.id, ADMIN)
    const clash = structuredClone(STANDARD_HIRE)
    ;(clash.workflow.nodes.find(n => n.key === 'interview')!.config as any).scorecard.find((f: any) => f.key === 'notes').type = 'number'
    const p = await add('Clashing', clash)
    await saveDraft(db, j.id, { form: p.form as unknown[], workflow: p.workflow as typeof clash.workflow })
    expect(await codes(j.id)).toEqual(['node_type_changed'])
    expect((await getJob(db, j.id)).job.publishedVersionId).toBe(live.id)
  })
})
