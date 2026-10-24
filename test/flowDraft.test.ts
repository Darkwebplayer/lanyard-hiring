import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { draftFlow, mockFlow } from '../server/domain/flowDraft'
import { validateVersion } from '../shared/workflow/graph'
import { stageView } from '../shared/workflow/stages'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { FormField } from '../shared/workflow/types'

// Phase 4 Describe your flow: the model only proposes; registry schemas + validateVersion decide.

const FORMS: Record<string, FormField[]> = {
  'Standard hire': STANDARD_HIRE.form,
  'no file field': [{ key: 'weekends', label: 'Which days can you work?', type: 'text', required: true }],
}

// A fake model: returns the scripted drafts in order and records what it was sent.
const scripted = (...drafts: unknown[]) => {
  const calls: ModelMessage[][] = []
  return { calls, generate: async (m: ModelMessage[]) => (calls.push(structuredClone(m)), drafts[Math.min(calls.length - 1, drafts.length - 1)]) }
}

describe('mock draft', () => {
  for (const [name, form] of Object.entries(FORMS)) {
    it(`is valid and fits the stage list (${name})`, async () => {
      const g = mockFlow(form)
      expect(validateVersion(form, g)).toEqual([])
      expect(stageView(g).fits).toBe(true)
      expect(g.nodes.some(n => n.type === 'cv_parse')).toBe(name === 'Standard hire')
      const { calls, generate } = scripted(g)
      const res = await draftFlow(generate, 'Café barista', form)
      expect(calls).toHaveLength(1) // valid first time: no repair
      expect(res.issues).toEqual([])
      expect(res.summary).toBe(name === 'Standard hire' ? '6 steps in 4 stages' : '5 steps in 4 stages')
    })
  }
})

describe('repair loop', () => {
  const form = STANDARD_HIRE.form
  const good = mockFlow(form)
  // bad config on one node, a position to strip
  const bad = structuredClone(good)
  bad.nodes.find(n => n.key === 'call')!.config = { title: 'Call', assignees: { users: [], roles: [], job_owner: true }, scorecard: [] }
  ;(bad.nodes[0] as any).position = { x: 1, y: 2 }

  it('sends registry config issues back with the node key, and takes the repaired draft', async () => {
    const { calls, generate } = scripted(bad, good)
    const res = await draftFlow(generate, 'x', form)
    expect(calls).toHaveLength(2)
    const fix = calls[1]!.at(-1)!.content as string
    expect(fix).toContain('call: scorecard')
    expect(calls[1]!.at(-2)).toMatchObject({ role: 'assistant' })
    expect(res.issues).toEqual([])
  })

  it('returns the draft with its issues after two failed repairs, without throwing', async () => {
    const { calls, generate } = scripted(bad)
    const res = await draftFlow(generate, 'x', form)
    expect(calls).toHaveLength(3)
    expect(res.issues).toContainEqual(expect.objectContaining({ node: 'call', code: 'invalid_config' }))
    expect(res.workflow.nodes[0]).not.toHaveProperty('position')
  })

  it('never throws on garbage or a broken graph', async () => {
    for (const junk of [null, 'nope', { nodes: 'x' }, { nodes: [], edges: [], stages: [] }]) {
      const res = await draftFlow(scripted(junk).generate, 'x', form)
      expect(res.issues.length).toBeGreaterThan(0)
    }
  })

  it('repairs a draft the stage list cannot draw (not a publish issue)', async () => {
    const unstaged = { ...good, stages: good.stages!.slice(1) }
    const { calls, generate } = scripted(unstaged, good)
    await draftFlow(generate, 'x', form)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.at(-1)!.content).toContain('isn’t in any stage')
  })
})
