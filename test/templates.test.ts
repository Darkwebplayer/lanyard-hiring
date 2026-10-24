import { describe, expect, it } from 'vitest'
import { validateVersion } from '../shared/workflow/graph'
import { TEMPLATES } from '../shared/workflow/templates'

describe('new-job templates', () => {
  it.each(TEMPLATES.map(t => [t.id, t] as const))('%s publishes as is', (_, t) => {
    expect(validateVersion(t.form, t.workflow)).toEqual([])
  })

  it('every resting step sits in a stage, so the board has no "Other steps" column', () => {
    for (const t of TEMPLATES) {
      const staged = new Set(t.workflow.stages!.flatMap(s => s.nodeKeys))
      const resting = t.workflow.nodes.filter(n => ['human_task', 'cv_parse', 'ai_review', 'send_email'].includes(n.type))
      expect(resting.filter(n => !staged.has(n.key)).map(n => n.key), t.id).toEqual([])
    }
  })
})
