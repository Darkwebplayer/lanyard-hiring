import { describe, expect, it } from 'vitest'
import { answersSchema, validateForm } from '../shared/workflow/form'
import { fieldsAvailableAt, validateGraph, validateVersion } from '../shared/workflow/graph'
import { aggregateScorecard, REGISTRY, runSetVariable, scorecardSchema } from '../shared/workflow/registry'
import { checkRule, evaluate, pickBranch, type Rule } from '../shared/workflow/rules'
import { MissingRefError, render } from '../shared/workflow/template'
import { STANDARD_HIRE } from '../shared/workflow/templates'
import type { Field, Graph } from '../shared/workflow/types'

const ctx = {
  candidate: { first_name: 'Jane', last_name: 'Doe', email: 'jane@x.com' },
  form: { notice_period_weeks: 4, start: '2026-11-01' },
  job: { title: 'Backend Engineer', openings: 2, must_have_skills: ['TypeScript'] },
  nodes: { ai: { overall: 72, summary: 'Strong' }, cv: { skills: ['TypeScript', 'Postgres'], text: 'Senior engineer' } },
}
const clone = () => structuredClone(STANDARD_HIRE)
const codes = (issues: { code: string }[]) => issues.map(i => i.code)

describe('rule evaluator', () => {
  const t = (rule: Rule) => evaluate(rule, ctx).result

  it('compares numbers, dates, strings, lists', () => {
    expect(t({ ref: 'nodes.ai.overall', op: 'gte', value: 70 })).toBe(true)
    expect(t({ ref: 'nodes.ai.overall', op: 'between', value: [73, 100] })).toBe(false)
    expect(t({ ref: 'form.start', op: 'gt', value: '2026-10-31' })).toBe(true)
    expect(t({ ref: 'candidate.first_name', op: 'eq', value: 'JANE' })).toBe(true) // case-insensitive
    expect(t({ ref: 'nodes.cv.skills', op: 'contains', value: 'postgres' })).toBe(true)
    expect(t({ ref: 'nodes.ai.overall', op: 'in', value: [70, 72] })).toBe(true)
    expect(t({ ref: 'nodes.cv.text', op: 'contains', value: 'senior' })).toBe(true)
  })

  it('valueRef compares two fields', () => {
    expect(t({ ref: 'nodes.cv.skills', op: 'contains', valueRef: 'job.title' })).toBe(false)
    expect(t({ ref: 'form.notice_period_weeks', op: 'lt', valueRef: 'job.openings' })).toBe(false)
  })

  it('all / any / not', () => {
    expect(t({ all: [{ ref: 'nodes.ai.overall', op: 'gt', value: 50 }, { ref: 'job.openings', op: 'eq', value: 2 }] })).toBe(true)
    expect(t({ any: [{ ref: 'nodes.ai.overall', op: 'lt', value: 50 }, { ref: 'job.openings', op: 'eq', value: 2 }] })).toBe(true)
    expect(t({ not: { ref: 'nodes.ai.overall', op: 'lt', value: 50 } })).toBe(true)
  })

  it('missing values make comparisons false and are marked in the trace', () => {
    const r = evaluate({ ref: 'nodes.interview.score', op: 'lt', value: 50 }, ctx)
    expect(r.result).toBe(false)
    expect(r.trace[0]).toMatchObject({ ref: 'nodes.interview.score', missing: true })
    expect(t({ ref: 'form.missing', op: 'exists' })).toBe(false)
    expect(t({ ref: 'form.notice_period_weeks', op: 'exists' })).toBe(true)
    // missing valueRef is missing too
    expect(t({ ref: 'nodes.ai.overall', op: 'gt', valueRef: 'nodes.nope.x' })).toBe(false)
  })

  it('evaluates every comparison (no short-circuit) so the trace is complete', () => {
    const r = evaluate({ any: [{ ref: 'job.openings', op: 'eq', value: 2 }, { ref: 'nodes.ai.overall', op: 'lt', value: 10 }] }, ctx)
    expect(r.trace).toHaveLength(2)
  })
})

describe('condition', () => {
  const config = {
    branches: [
      { key: 'shortlist', label: 'S', rule: { ref: 'nodes.ai.overall', op: 'gte', value: 70 } as Rule },
      { key: 'also', label: 'A', rule: { ref: 'nodes.ai.overall', op: 'gte', value: 50 } as Rule },
    ],
    on_missing: true,
  }

  it('first match wins, then default', () => {
    expect(pickBranch(config, ctx).branch).toBe('shortlist')
    expect(pickBranch(config, { ...ctx, nodes: { ai: { overall: 10 } } }).branch).toBe('default')
  })

  it('missing data takes the missing branch when there is one, else falls through', () => {
    const noAi = { ...ctx, nodes: {} }
    expect(pickBranch(config, noAi)).toMatchObject({ branch: 'missing', missing: ['nodes.ai.overall'] })
    expect(pickBranch({ ...config, on_missing: false }, noAi).branch).toBe('default')
  })

  it('stores an evaluation for every branch', () => {
    expect(pickBranch(config, ctx).branches.map(b => [b.key, b.result])).toEqual([['shortlist', true], ['also', true]])
  })
})

describe('rule checks', () => {
  const fields = new Map<string, Field>([
    ['nodes.ai.overall', { path: 'nodes.ai.overall', type: 'number', label: '' }],
    ['form.level', { path: 'form.level', type: 'enum', label: '', options: ['junior', 'senior'] }],
    ['nodes.cv.skills', { path: 'nodes.cv.skills', type: 'list', label: '' }],
    ['job.title', { path: 'job.title', type: 'string', label: '' }],
  ])
  const check = (rule: Rule) => codes(checkRule(rule, fields, 'n'))

  it('accepts well-typed rules', () => {
    expect(check({ ref: 'nodes.ai.overall', op: 'between', value: [40, 69] })).toEqual([])
    expect(check({ ref: 'form.level', op: 'in', value: ['senior'] })).toEqual([])
    expect(check({ ref: 'nodes.cv.skills', op: 'contains', valueRef: 'job.title' })).toEqual([])
  })

  it('rejects unknown refs, wrong operators, wrong values, unknown enum options', () => {
    expect(check({ ref: 'nodes.x.y', op: 'exists' })).toEqual(['unknown_ref'])
    expect(check({ ref: 'nodes.ai.overall', op: 'contains', value: 'x' })).toEqual(['bad_operator'])
    expect(check({ ref: 'nodes.ai.overall', op: 'gt', value: 'high' })).toEqual(['bad_value'])
    expect(check({ ref: 'nodes.ai.overall', op: 'between', value: [1] })).toEqual(['bad_value'])
    expect(check({ ref: 'form.level', op: 'eq', value: 'staff' })).toEqual(['bad_value'])
    expect(check({ ref: 'nodes.ai.overall', op: 'gt', valueRef: 'job.title' })).toEqual(['type_mismatch'])
  })
})

describe('templates', () => {
  it('renders refs, lists and missing values', () => {
    expect(render('Hi {{candidate.first_name}}, {{ job.title }} · {{nodes.cv.skills}}', ctx)).toBe('Hi Jane, Backend Engineer · TypeScript, Postgres')
    expect(render('score {{nodes.interview.score}}', ctx)).toBe('score ')
  })

  it('strict mode throws on missing refs (emails)', () => {
    expect(() => render('Dear {{candidate.middle_name}}', ctx, { strict: true })).toThrow(MissingRefError)
  })
})

describe('form', () => {
  const form = STANDARD_HIRE.form

  it('validates form definitions', () => {
    expect(validateForm(form)).toEqual([])
    expect(codes(validateForm([...form, form[0]]))).toEqual(['duplicate_field'])
    expect(codes(validateForm([{ key: 'level', label: 'L', type: 'enum', required: true }]))).toEqual(['enum_without_options'])
    expect(codes(validateForm([{ key: 'Bad Key', label: 'L', type: 'string', required: true }]))).toEqual(['invalid_form'])
  })

  it('generates an answers schema: coercion, empty-as-absent, required', () => {
    const s = answersSchema([
      ...form,
      { key: 'remote', label: 'Remote?', type: 'boolean', required: false },
      { key: 'langs', label: 'Languages', type: 'list', required: false },
    ])
    const file = { key: 'k', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'cv.pdf' }
    expect(s.parse({ cv: file, linkedin: '  ', notice_period_weeks: '4', remote: 'on', langs: 'English', junk: 1 }))
      .toEqual({ cv: file, notice_period_weeks: 4, remote: true, langs: ['English'] })
    expect(s.safeParse({ linkedin: 'x' }).success).toBe(false) // cv required
    expect(s.safeParse({ cv: file, notice_period_weeks: '99' }).success).toBe(false) // max 52
    expect(s.safeParse({ cv: { ...file, mime: 'text/plain' } }).success).toBe(false)
  })
})

describe('human task', () => {
  const card = REGISTRY.human_task!.config.parse({
    title: 't',
    assignees: { job_owner: true },
    scorecard: [
      { key: 'score', label: 'S', type: 'number', min: 1, max: 5 },
      { key: 'hire', label: 'H', type: 'boolean' },
      { key: 'notes', label: 'N', type: 'text', required: false },
    ],
    min_submissions: 2,
  }).scorecard

  it('aggregates: average, all/any, joined text', () => {
    expect(aggregateScorecard(card, [{ score: 4, hire: true, notes: 'good' }, { score: 3, hire: false }])).toEqual({
      submitted_count: 2, score: 3.5, hire: false, hire_any: true, notes: 'good',
    })
  })

  it('validates submissions against the scorecard', () => {
    const s = scorecardSchema(card)
    expect(s.safeParse({ score: 4, hire: true }).success).toBe(true)
    expect(s.safeParse({ score: 9, hire: true }).success).toBe(false)
    expect(s.safeParse({ score: 4 }).success).toBe(false)
    expect(s.safeParse({ score: 4, hire: true, extra: 1 }).success).toBe(false)
  })

  it('needs at least one assignee rule', () => {
    expect(REGISTRY.human_task!.config.safeParse({ title: 't', assignees: {}, scorecard: card }).success).toBe(false)
  })
})

describe('set variable', () => {
  it('copies literals and refs', () => {
    const c = REGISTRY.set_variable!.config.parse({
      fields: [{ key: 'tier', type: 'string', source: { kind: 'literal', value: 'gold' } }, { key: 'score', type: 'number', source: { kind: 'ref', ref: 'nodes.ai.overall' } }],
    })
    expect(runSetVariable(c, ctx)).toEqual({ tier: 'gold', score: 72 })
  })
})

describe('graph validation', () => {
  it('the Standard hire template is valid', () => {
    expect(validateVersion(STANDARD_HIRE.form, STANDARD_HIRE.workflow)).toEqual([])
  })

  const issuesFor = (mutate: (g: Graph) => void) => {
    const t = clone()
    mutate(t.workflow)
    return codes(validateGraph(t.workflow, t.form))
  }
  const node = (g: Graph, key: string) => g.nodes.find(n => n.key === key)!

  it('trigger rules', () => {
    expect(issuesFor(g => g.nodes.push({ key: 'start2', type: 'application_received', config: {} }))).toContain('trigger_count')
    expect(issuesFor(g => g.edges.push({ from: 'cv', to: 'start' }))).toContain('trigger_incoming')
  })

  it('node rules: keys, types, configs', () => {
    expect(issuesFor(g => { node(g, 'cv').key = 'CV' })).toContain('bad_key')
    expect(issuesFor(g => { node(g, 'cv').type = 'magic' })).toContain('unknown_type')
    expect(issuesFor(g => { node(g, 'hired').config = { outcome: 'promoted' } })).toContain('invalid_config')
  })

  it('edge rules', () => {
    expect(issuesFor(g => g.edges.push({ from: 'cv', to: 'nowhere' }))).toContain('dangling_edge')
    expect(issuesFor(g => g.edges.push({ from: 'cv', to: 'screen' }))).toContain('out_edges') // two outgoing
    expect(issuesFor(g => g.edges.push({ from: 'hired', to: 'rejected' }))).toContain('end_outgoing')
    expect(issuesFor(g => { g.edges = g.edges.filter(e => !(e.from === 'screen' && e.branch === 'missing')) })).toContain('branch_edges')
    expect(issuesFor(g => g.edges.push({ from: 'screen', to: 'rejected', branch: 'maybe' }))).toContain('unknown_branch')
  })

  it('no cycles, everything reachable', () => {
    expect(issuesFor(g => {
      g.edges = g.edges.filter(e => !(e.from === 'offer_email'))
      g.edges.push({ from: 'offer_email', to: 'interview' })
    })).toContain('cycle')
    expect(issuesFor(g => g.nodes.push({ key: 'orphan', type: 'end', config: { outcome: 'withdrawn' } }))).toContain('unreachable')
  })

  it('refs must be upstream on every path', () => {
    // interview is not on every path to rejection_email, so its fields are off limits there
    expect(issuesFor(g => {
      (node(g, 'rejection_email').config as any).body = 'Score {{nodes.interview.technical}}'
    })).toContain('unknown_ref')
    // but fine for the offer email, which always comes after the interview
    expect(issuesFor(g => {
      (node(g, 'offer_email').config as any).body = 'Score {{nodes.interview.technical}}'
    })).toEqual([])
    // cv_parse must point at a file field
    expect(issuesFor(g => { (node(g, 'cv').config as any).file_field = 'linkedin' })).toContain('type_mismatch')
  })

  it('variable picker lists dominator outputs only', () => {
    const paths = (k: string) => fieldsAvailableAt(STANDARD_HIRE.workflow, k, STANDARD_HIRE.form).map(f => f.path)
    expect(paths('screen')).toContain('nodes.ai.overall')
    expect(paths('screen')).not.toContain('nodes.screen.x')
    expect(paths('rejection_email')).not.toContain('nodes.interview.hire')
    expect(paths('decision')).toEqual(expect.arrayContaining(['nodes.interview.hire', 'nodes.interview.hire_any', 'form.cv', 'job.title']))
    expect(paths('start')).not.toContain('nodes.cv.text')
  })
})
