import { describe, expect, it } from 'vitest'
import { boltLine, dropEffects, dropTag, needsReason } from '../app/lib/board'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Graph } from '../shared/workflow/types'

const G = STANDARD_HIRE.workflow
const n = (node: string) => ({ node })
const names = (id: string) => ({ u1: 'Priya Nair', u2: 'Tomás Hale' } as Record<string, string>)[id]

describe('board drag labels', () => {
  it('labels every kind of target', () => {
    expect(dropTag(G, n('ai'), n('interview'))).toEqual({ kind: 'next', text: 'Next · “Shortlist”' })
    expect(dropTag(G, n('cv'), n('ai'))).toEqual({ kind: 'next', text: 'Next' })
    expect(dropTag(G, n('cv'), n('interview')).text).toBe('Skips 1 step')
    expect(dropTag(G, n('interview'), n('cv')).text).toBe('Goes back')
    expect(dropTag(G, n('interview'), { closed: 'hired' }).text).toBe('Close as hired')
    expect(dropTag(G, n('interview'), { closed: 'rejected' }).text).toBe('Close as rejected · asks a reason')
    expect(dropTag(G, n('rejection_email'), { closed: 'rejected' }).text).toBe('Next · asks a reason')
    expect(dropTag(G, n('cv'), { closed: 'withdrawn' }).text).toBe('Any step can close here')
    expect(dropTag(G, { closed: 'rejected' }, n('cv')).text).toBe('Reopens here')
    expect(dropTag(null, n('cv'), n('ai')).kind).toBe('other') // no published flow: nothing counts as next
  })

  it('asks for a reason only off the flow; a reject takes a listed one', () => {
    expect(needsReason(G, n('cv'), n('ai'))).toBe(false)
    expect(needsReason(G, n('cv'), n('interview'))).toBe(true)
    expect(needsReason(G, n('interview'), { closed: 'rejected' })).toBe(false)
  })
})

describe('board effect lines', () => {
  const g: Graph = structuredClone(G)
  const iv = g.nodes.find(x => x.key === 'interview')!
  iv.config = { ...(iv.config as object), assignees: { users: ['u1', 'u2'], roles: [], job_owner: false }, booking: { duration_min: 30 } }

  it('names the people a task goes to, and says one each for a group', () => {
    const [assign, booking] = dropEffects(g, n('interview'), names)
    expect(assign!.text).toMatch(/goes to Priya Nair, Tomás Hale/)
    expect(booking!.text).toBe('They’re asked to book a 30-minute slot')
    expect(dropEffects(g, n('interview'), names, true)[0]!.text).toMatch(/, one for each of them$/)
    expect(dropEffects(g, n('interview'), () => undefined)[0]!.text).toMatch(/goes to 2 people/)
  })

  it('writes the column line short', () => {
    expect(boltLine(G, 'screening', names)).toBe('Reads the CV · AI scores them · Assigns the job owner')
    expect(boltLine(g, 'interview', names)).toBe('Assigns Priya, Tomás · booking link')
    expect(boltLine(G, 'decision', names)).toBe('Emails “Rejection email”')
    expect(boltLine(G, 'offer', names)).toBe('Assigns the job owner')
  })
})
