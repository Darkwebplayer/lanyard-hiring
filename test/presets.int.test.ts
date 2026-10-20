import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../server/db/client'
import { DomainError } from '../server/domain/errors'
import { createPreset, deletePreset, listPresets, presetInput, reorderSection, updatePreset } from '../server/domain/presets'
import { BUILTIN_PRESETS } from '../shared/workflow/presets'
import { testDb } from './db'

let db: Db
beforeAll(async () => { db = await testDb() })
afterAll(() => db.close())

const rejects = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(DomainError)
  expect(e).toMatchObject({ status, message })
}
const add = (type: string, label: string, config: unknown) => createPreset(db, presetInput.parse({ type, label, config }))

describe('step presets', () => {
  it('a new company starts with the built-ins, ordered per section', async () => {
    const all = await listPresets(db)
    expect(all.map(p => p.label)).toEqual(expect.arrayContaining(BUILTIN_PRESETS.map(p => p.label)))
    expect(all.filter(p => p.type === 'human_task').map(p => [p.label, p.position])).toEqual([['Interview', 0], ['Technical assessment review', 1], ['HR approval', 2]])
    expect(all.every(p => p.inPalette)).toBe(true)
  })

  it('checks the config shape for its type and adds new ones at the end of their section', async () => {
    await rejects(add('send_email', 'Broken', { subject: '' }), 422, 'invalid_preset')
    expect(() => presetInput.parse({ type: 'application_received', label: 'Start', config: {} })).toThrow()
    const p = await add('send_email', 'Assessment invite', { subject: 'Your assessment for {{job.title}}', body: 'Hi {{candidate.first_name}}, here it is.' })
    // the system section holds ai_review (0), the two emails (1, 2): the new one goes after them
    expect(p.position).toBe(3)
    const ht = await add('human_task', 'Reference check', { title: 'Call references for {{candidate.first_name}}', assignees: { job_owner: true }, scorecard: [{ key: 'ok', label: 'Good references?', type: 'boolean' }] })
    expect(ht.config).toMatchObject({ min_submissions: 1, assignees: { users: [], roles: [], job_owner: true } }) // defaults applied
  })

  it('reorders a section only with its full, current list; edits and deletes', async () => {
    const people = (await listPresets(db)).filter(p => p.type === 'human_task')
    const reversed = people.map(p => p.id).reverse()
    expect((await reorderSection(db, 'person', reversed)).map(p => p.id)).toEqual(reversed)
    await rejects(reorderSection(db, 'person', reversed.slice(1)), 409, 'section_changed')
    await rejects(reorderSection(db, 'nope', []), 422, 'unknown_section')

    const target = people[0]!
    expect(await updatePreset(db, target.id, { inPalette: false, label: 'Interview (panel)' })).toMatchObject({ inPalette: false, label: 'Interview (panel)', type: 'human_task' })
    await rejects(updatePreset(db, target.id, { config: { title: '' } }), 422, 'invalid_preset')
    await deletePreset(db, target.id)
    await rejects(deletePreset(db, target.id), 404, 'preset_not_found')
  })
})
