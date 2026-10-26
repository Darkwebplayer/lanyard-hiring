import { describe, expect, it } from 'vitest'
import { validateGraph } from '../shared/workflow/graph'
import { arrivalEffects, insertAfter, relation, removeStep, stageSummary, stageView } from '../shared/workflow/stages'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Graph, GraphNode } from '../shared/workflow/types'

const G = STANDARD_HIRE.workflow
const n = (node: string) => ({ node })
const task = (key: string, extra: object = {}): GraphNode => ({
  key, type: 'human_task', label: key,
  config: { title: 'Do it', assignees: { users: ['u1', 'u2'], roles: [], job_owner: false }, scorecard: [{ key: 'ok', label: 'OK?', type: 'boolean', required: true }], min_submissions: 1, ...extra },
})
const email = (key: string): GraphNode => ({ key, type: 'send_email', label: key, config: { subject: 'Hi', body: 'Hello' } })

// start → a → pick {fast: c, default: b} ; b → c → end(hired)
const small: Graph = {
  nodes: [
    { key: 'start', type: 'application_received', config: {} },
    task('a'), task('b'), email('c'),
    { key: 'pick', type: 'condition', config: { branches: [{ key: 'fast', label: 'Fast track', rule: { ref: 'nodes.a.ok', op: 'is_true' } }], on_missing: false } },
    { key: 'done', type: 'end', config: { outcome: 'hired' } },
  ],
  edges: [
    { from: 'start', to: 'a' }, { from: 'a', to: 'pick' },
    { from: 'pick', to: 'b', branch: 'default' }, { from: 'pick', to: 'c', branch: 'fast' },
    { from: 'b', to: 'c' }, { from: 'c', to: 'done' },
  ],
  stages: [{ id: 's1', name: 'One', nodeKeys: ['a', 'b'] }, { id: 's2', name: 'Two', nodeKeys: ['c'] }],
}

describe('relation', () => {
  it('names next moves with their branch, skips, back and other', () => {
    expect(relation(G, n('cv'), n('ai'))).toEqual({ kind: 'next' })
    expect(relation(G, n('ai'), n('interview'))).toEqual({ kind: 'next', branch: 'Shortlist' })
    expect(relation(G, n('ai'), n('manual_review'))).toEqual({ kind: 'next', branch: 'Otherwise' }) // default before missing
    expect(relation(G, n('interview'), n('rejection_email'))).toEqual({ kind: 'next', branch: 'Otherwise' })
    expect(relation(G, n('make_offer'), n('documents'))).toEqual({ kind: 'next', branch: 'Accepted' })
    expect(relation(G, n('cv'), n('interview'))).toEqual({ kind: 'skip', steps: 1 })
    expect(relation(G, n('interview'), { closed: 'hired' })).toEqual({ kind: 'skip', steps: 2 })
    expect(relation(G, n('interview'), n('cv'))).toEqual({ kind: 'back' })
    expect(relation(G, n('interview'), { closed: 'withdrawn' })).toEqual({ kind: 'skip', steps: 1 }) // a declined offer
    expect(relation(G, n('rejection_email'), { closed: 'withdrawn' })).toEqual({ kind: 'other' })
    expect(relation(G, { closed: 'rejected' }, n('cv'))).toEqual({ kind: 'other' })
    expect(relation(G, { closed: 'rejected' }, { closed: 'hired' })).toEqual({ kind: 'other' })
    expect(relation(G, n('cv'), n('cv'))).toEqual({ kind: 'other' })
    expect(relation(G, n('make_offer'), n('rejection_email'))).toEqual({ kind: 'other' })
  })

  it('takes the shortest way when one exists past a branch', () => {
    expect(relation(small, n('a'), n('c'))).toEqual({ kind: 'next', branch: 'Fast track' })
    expect(relation(small, n('a'), n('b'))).toEqual({ kind: 'next', branch: 'Otherwise' })
    expect(relation(small, n('b'), { closed: 'hired' })).toEqual({ kind: 'skip', steps: 1 })
  })
})

describe('arrivalEffects', () => {
  it('says what a move sets off, per moveApplication', () => {
    expect(arrivalEffects(G, n('cv')).map(e => [e.kind, e.nodeKey])).toEqual([['auto', 'cv'], ['auto', 'ai']]) // stops at the decision
    expect(arrivalEffects(G, n('interview'))).toEqual([{
      kind: 'assign', text: '“Interview” goes to the job owner, due in 5 days', nodeKey: 'interview',
      assignees: { users: [], roles: [], job_owner: true }, dueDays: 5,
    }])
    expect(arrivalEffects(G, n('make_offer')).map(e => e.text)).toEqual(['“Make offer” goes to the job owner, due in 3 days'])
    expect(arrivalEffects(G, n('rejection_email')).map(e => e.text)).toEqual(['Sends them “Rejection email”. It can’t be unsent.', 'Then closes them as rejected'])
    expect(arrivalEffects(G, { closed: 'rejected' })).toEqual([{ kind: 'close', outcome: 'rejected', text: expect.stringContaining('No email is sent') }])
    expect(arrivalEffects(G, n('rejection_email')).at(-1)?.outcome).toBe('rejected')
  })

  it('mentions booking and panels', () => {
    const g = { ...small, nodes: small.nodes.map(x => x.key === 'a' ? task('a', { booking: { duration_min: 30 }, min_submissions: 2, due_days: 0 }) : x) }
    expect(arrivalEffects(g, n('a')).map(e => e.text)).toEqual(['“a” goes to 2 people, due today, 2 answers needed', 'They’re asked to book a 30-minute slot'])
  })
})

describe('stageSummary', () => {
  it('lists what each column does, in flow order', () => {
    expect(stageSummary(G, 'screening').map(e => e.nodeKey)).toEqual(['cv', 'ai', 'manual_review'])
    expect(stageSummary(G, 'decision').map(e => e.text)).toEqual(['Sends them “Rejection email”'])
    expect(stageSummary(G, 'nope')).toEqual([])
  })
})

describe('stageView', () => {
  it('reads the standard flow as stages', () => {
    const v = stageView(G)
    expect(v.fits).toBe(true)
    expect(v.start).toEqual({ key: 'start', exits: [{ to: { stage: 'screening', node: 'cv' } }] })
    const [screening, interview, offer, decision] = v.stages
    expect(screening!.auto.map(s => s.key)).toEqual(['cv', 'ai'])
    expect(screening!.people.map(s => s.key)).toEqual(['manual_review'])
    expect(screening!.exits).toContainEqual({ condition: 'screen', branch: 'shortlist', label: 'Shortlist', rule: { ref: 'nodes.ai.overall', op: 'gte', value: 70 }, to: { stage: 'interview', node: 'interview' } })
    expect(screening!.exits).toContainEqual({ condition: 'screen', branch: 'missing', label: 'Missing data', to: { stage: 'screening', node: 'manual_review' } })
    expect(screening!.exits).toContainEqual({ condition: 'review_decision', branch: 'default', label: 'Otherwise', to: { stage: 'decision', node: 'rejection_email' } })
    expect(interview!.exits.map(x => x.label)).toEqual(['Hire', 'Otherwise'])
    expect(decision!.exits).toEqual([{ to: { closed: 'rejected' } }])
    // Make offer: the answer decides, accepted → documents → hired, otherwise → withdrawn
    expect(offer!.people.map(s => s.key)).toEqual(['make_offer', 'documents'])
    expect(offer!.exits.map(x => [x.label, x.to])).toEqual([['Accepted', { stage: 'offer', node: 'documents' }], ['Otherwise', { closed: 'withdrawn' }], [undefined, { closed: 'hired' }]])
    expect(v.unstaged).toEqual([])
    expect(v.closed.map(c => [c.outcome, c.ends])).toEqual([['hired', ['hired']], ['rejected', ['rejected']], ['withdrawn', ['withdrawn']]])
  })

  it('refuses flows a stage list would misstate', () => {
    expect(stageView({ ...G, stages: undefined })).toMatchObject({ fits: false, reason: 'This workflow has no stages yet.' })
    const unstaged = stageView({ ...small, stages: [{ id: 's1', name: 'One', nodeKeys: ['a', 'b'] }] })
    expect(unstaged).toMatchObject({ fits: false, reason: '“c” isn’t in any stage.' })
    expect(unstaged.unstaged.map(s => s.key)).toEqual(['c'])
    // b in a later stage than c, but b leads to c: people would go back
    const back = stageView({ ...small, stages: [{ id: 's1', name: 'One', nodeKeys: ['a'] }, { id: 's2', name: 'Two', nodeKeys: ['c'] }, { id: 's3', name: 'Three', nodeKeys: ['b'] }] })
    expect(back).toMatchObject({ fits: false, reason: '“b” sends people back to Two.' })
  })
})

describe('insertAfter / removeStep', () => {
  it('inserts a step and removes it again, keeping stages and validity', () => {
    const g = insertAfter(G, 'interview', task('second', { assignees: { users: [], roles: [], job_owner: true } }))
    expect(g.edges).toContainEqual({ from: 'interview', to: 'second' })
    expect(g.edges).toContainEqual({ from: 'second', to: 'decision' })
    expect(g.stages!.find(s => s.id === 'interview')!.nodeKeys).toEqual(['interview', 'second'])
    expect(validateGraph(g, STANDARD_HIRE.form)).toEqual([])
    expect(relation(g, n('interview'), n('second'))).toEqual({ kind: 'next' })
    const back = removeStep(g, 'second')!
    expect(back.edges).toEqual(expect.arrayContaining(G.edges))
    expect(back.edges).toHaveLength(G.edges.length)
    expect(back.stages).toEqual(G.stages)
    expect(G.nodes.some(x => x.key === 'second')).toBe(false) // immutable
  })

  it('joins the next stage when inserted after the start', () => {
    const g = insertAfter(G, 'start', email('welcome'))
    expect(g.stages![0]!.nodeKeys[0]).toBe('welcome')
    expect(() => insertAfter(G, 'screen', email('x'))).toThrow()
  })

  it('rewires every way in, and refuses unsafe removals', () => {
    expect(removeStep(G, 'make_offer')).toBeNull() // offer_answer reads its answer
    expect(removeStep(G, 'interview')).toBeNull() // decision reads its answers
    expect(removeStep(G, 'screen')).toBeNull()
    expect(removeStep(G, 'start')).toBeNull()
    expect(removeStep(G, 'hired')).toBeNull()
    const r = removeStep(G, 'rejection_email')! // three ways in
    expect(r.edges.filter(e => e.to === 'rejected').length).toBe(3)
    expect(validateGraph(r, STANDARD_HIRE.form)).toEqual([])
  })
})
