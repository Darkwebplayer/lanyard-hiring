import { describe, expect, it, vi } from 'vitest'
import { removeStep, stageView } from '../shared/workflow/stages'
import { TEMPLATES } from '../shared/workflow/templates'

// app/lib/flow uses Nuxt aliases; point them at the real files
vi.mock('~/utils/nodes', () => import('../app/utils/nodes'))
vi.mock('~~/shared/workflow/presets', () => import('../shared/workflow/presets'))
vi.mock('~~/shared/workflow/registry', () => import('../shared/workflow/registry'))
const { insertBefore, removeBlocker, ruleWords } = await import('../app/lib/flow')

const email = { key: 'hello', type: 'send_email', config: { subject: 'Hi', body: 'Hi' } }

describe('stage editor helpers', () => {
  it('puts a step in front of another, in the given stage, and the list still fits', () => {
    for (const t of TEMPLATES) {
      const g = t.workflow
      const stage = g.stages![1]!
      const first = stageView(g).stages[1]!
      const before = [...first.auto, ...first.people][0]!.key
      const next = insertBefore(g, before, email, stage.id)
      expect(next.edges.filter(e => e.to === before)).toEqual([{ from: 'hello', to: before }])
      expect(next.stages!.find(s => s.id === stage.id)!.nodeKeys).toContain('hello')
      expect(stageView(next).fits).toBe(true)
    }
  })

  it('says why a step can’t be removed', () => {
    const g = TEMPLATES.find(t => t.id === 'ai_screening')!.workflow
    expect(removeStep(g, 'ai')).toBeNull()
    expect(removeBlocker(g, 'ai')).toMatch(/uses its answers/)
  })

  it('reads a rule in words', () => {
    const fields = [{ path: 'nodes.ai.overall', type: 'number' as const, label: 'AI review: Overall score' }]
    expect(ruleWords({ ref: 'nodes.ai.overall', op: 'gte', value: 70 }, fields)).toBe('AI review: Overall score is at least 70')
    expect(ruleWords({ all: [{ ref: 'nodes.ai.overall', op: 'gte', value: 40 }, { ref: 'nodes.ai.overall', op: 'lt', value: 70 }] }, fields))
      .toBe('AI review: Overall score is at least 40 and AI review: Overall score is less than 70')
    expect(ruleWords({ ref: 'x', op: 'gte', value: 70 }, [{ path: 'x', type: 'number', label: 'AI review: Overall score (0–100)' }])).toBe('AI review: Overall score is at least 70')
  })
})
