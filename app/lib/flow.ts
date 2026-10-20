// Canvas helpers: layout, words for each step, palette defaults. Pure, so the editor stays about state.
import { nodeLabel } from '~/utils/nodes'
import { HUMAN_TASK_PRESETS, REGISTRY, conditionBranchKeys, type HumanTaskConfig } from '~~/shared/workflow/registry'
import type { ConditionConfig, Op, Rule } from '~~/shared/workflow/rules'
import type { Field, FieldType, FormField, Graph, GraphEdge, GraphNode, Issue } from '~~/shared/workflow/types'

export interface Role { id: string, name: string, level: string }
export interface Person { id: string, name: string, email: string }

export const GRID = 24
export const CARD_W = 240
const BRANCH_W = 100
const ROW_GAP = 120
const COL_GAP = 48

const snap = (v: number) => Math.round(v / GRID) * GRID

// ---------- words ----------

export const titleOf = (n: GraphNode) => nodeLabel(n)

// snake_case key from a label: "Hire?" → "hire"
export const slug = (label: string, fallback = 'item') => {
  const s = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return !s ? fallback : /^[a-z]/.test(s) ? s : `${fallback}_${s}`.slice(0, 40)
}

export const uniqueKey = (base: string, taken: Iterable<string>) => {
  const set = new Set(taken)
  if (!set.has(base)) return base
  let i = 2
  while (set.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

const asCondition = (n: GraphNode): ConditionConfig => {
  const c = (n.config ?? {}) as Partial<ConditionConfig>
  return { branches: Array.isArray(c.branches) ? c.branches : [], on_missing: !!c.on_missing }
}

export const branchKeys = (n: GraphNode) => conditionBranchKeys(asCondition(n))

export const branchLabel = (n: GraphNode, key: string) =>
  key === 'default' ? 'Otherwise' : key === 'missing' ? 'Missing data' : asCondition(n).branches.find(b => b.key === key)?.label || key

// multiples of 2 grid cells, so a card centred on a grid line also starts on one (edges then run straight)
export const cardWidth = (n: GraphNode) => n.type === 'condition' ? Math.max(CARD_W, Math.ceil((branchKeys(n).length * BRANCH_W + 16) / (GRID * 2)) * GRID * 2) : CARD_W
const cardHeight = (n: GraphNode) => n.type === 'condition' ? 108 : 100

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// One line in the recruiter's words, built from the step's settings.
export function summaryOf(n: GraphNode, form: FormField[], roles: Role[]): string {
  const c = (n.config ?? {}) as any
  switch (n.type) {
    case 'application_received': return 'When someone applies'
    case 'cv_parse': {
      const f = form.find(x => x.key === c.file_field)
      return f ? `From: ${f.label}` : 'Choose the file to read'
    }
    case 'ai_review': {
      const ref: string | undefined = c.cv_text_ref
      const src = !ref ? 'no CV text' : ref.endsWith('.text') && ref.startsWith('nodes.') ? 'CV text' : form.find(x => `form.${x.key}` === ref)?.label ?? ref
      return `${plural(c.criteria?.length ?? 0, 'criterion', 'criteria')} · ${src}`
    }
    case 'condition': {
      const k = branchKeys(n)
      return k.map(b => b === 'default' ? 'otherwise' : b === 'missing' ? 'missing data' : branchLabel(n, b)).join(' · ')
    }
    case 'human_task': {
      const a = c.assignees ?? {}
      const who = [
        a.job_owner && 'Job owner',
        ...(a.roles ?? []).map((id: string) => roles.find(r => r.id === id)?.name ?? 'a role'),
        a.users?.length && plural(a.users.length, 'person', 'people'),
      ].filter(Boolean).join(' + ') || 'Nobody yet'
      return [
        who,
        plural(c.scorecard?.length ?? 0, 'question'),
        c.due_days !== undefined && plural(c.due_days, 'day'),
        c.min_submissions > 1 && `Panel of ${c.min_submissions}`,
      ].filter(Boolean).join(' · ')
    }
    case 'send_email': return c.subject ? `“${c.subject}”` : 'No subject yet'
    case 'set_variable': return `${plural(c.fields?.length ?? 0, 'value')}${c.fields?.length ? `: ${c.fields.map((f: any) => f.key).join(', ')}` : ''}`
    case 'end': return `Closes the application as ${c.outcome === 'hired' ? 'hired' : c.outcome === 'withdrawn' ? 'withdrawn' : 'rejected'}`
  }
  return REGISTRY[n.type]?.label ?? n.type
}

// Problems in plain words where the validator speaks in graph terms; everything else as the backend wrote it.
export function issueText(i: Issue, g: Graph): string {
  const n = g.nodes.find(x => x.key === i.node)
  switch (i.code) {
    case 'out_edges': return /has 0/.test(i.message) ? 'Isn’t connected to a next step' : 'Leads to more than one step; keep one'
    case 'branch_edges': {
      const b = /branch "([^"]+)"/.exec(i.message)?.[1] ?? ''
      const lbl = n ? branchLabel(n, b) : b
      return /has 0/.test(i.message) ? `“${lbl}” doesn’t lead to a step yet` : `“${lbl}” leads to more than one step`
    }
    case 'unreachable': return 'Nothing leads to this step'
    case 'end_outgoing': return 'An ending can’t lead anywhere'
    case 'trigger_incoming': return 'Nothing can lead back to the start'
    case 'cycle': return 'The flow loops back on itself; loops aren’t supported'
    case 'dangling_edge': return 'Points at a step that no longer exists'
    case 'self_loop': return 'Connects to itself'
    case 'unknown_branch': return 'Has a link that matches no branch'
    case 'unknown_ref': {
      const p = /"([^"]+)"/.exec(i.message)?.[1]
      return p ? `Uses {{${p}}}, which isn’t available at this step` : i.message
    }
    case 'protected_ref': return 'Shows a protected answer to interviewers; remove it'
  }
  return i.message.charAt(0).toUpperCase() + i.message.slice(1)
}

// ---------- graph ----------

// Does `from` reach `to` along edges? (Connecting to→from would close a loop.)
export function reaches(g: Graph, from: string, to: string) {
  const seen = new Set([from])
  const stack = [from]
  while (stack.length) {
    const k = stack.pop()!
    if (k === to) return true
    for (const e of g.edges) if (e.from === k && !seen.has(e.to)) seen.add(e.to), stack.push(e.to)
  }
  return false
}

// Outgoing edges in branch order, so a decision's children spread left to right like its handles.
const outOrdered = (g: Graph, n: GraphNode): GraphEdge[] => {
  const out = g.edges.filter(e => e.from === n.key)
  if (n.type !== 'condition') return out
  const order = branchKeys(n)
  return out.sort((a, b) => order.indexOf(a.branch ?? '') - order.indexOf(b.branch ?? ''))
}

// Top-to-bottom by longest path from the start; each step's children spread around it; rows pushed apart.
export function layout(g: Graph): Map<string, { x: number, y: number }> {
  const byKey = new Map(g.nodes.map(n => [n.key, n]))
  const depth = new Map(g.nodes.map(n => [n.key, 0]))
  // Bellman-style relaxation, capped at n passes so a loop can't spin forever
  for (let i = 0; i < g.nodes.length; i++) {
    let changed = false
    for (const e of g.edges) {
      if (!byKey.has(e.from) || !byKey.has(e.to) || e.from === e.to) continue
      const d = depth.get(e.from)! + 1
      if (d > depth.get(e.to)! && d < g.nodes.length) depth.set(e.to, d), changed = true
    }
    if (!changed) break
  }
  const order = [...g.nodes].sort((a, b) => depth.get(a.key)! - depth.get(b.key)!)
  const cx = new Map<string, number>()
  const colW = CARD_W + 72
  for (const n of order) {
    if (!cx.has(n.key)) cx.set(n.key, 0)
    const kids = [...new Set(outOrdered(g, n).map(e => e.to))].filter(k => byKey.has(k) && !cx.has(k))
    kids.forEach((k, i) => cx.set(k, cx.get(n.key)! + (i - (kids.length - 1) / 2) * colW))
  }
  const rows = new Map<number, GraphNode[]>()
  for (const n of order) rows.set(depth.get(n.key)!, [...(rows.get(depth.get(n.key)!) ?? []), n])
  const out = new Map<string, { x: number, y: number }>()
  let y = 0
  for (const d of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(d)!.sort((a, b) => cx.get(a.key)! - cx.get(b.key)!)
    const before = row.map(n => cx.get(n.key)!)
    for (let i = 1; i < row.length; i++) {
      const min = cx.get(row[i - 1]!.key)! + (cardWidth(row[i - 1]!) + cardWidth(row[i]!)) / 2 + COL_GAP
      if (cx.get(row[i]!.key)! < min) cx.set(row[i]!.key, min)
    }
    // pushing only rightwards skews the row; give half the push back
    const shift = row.reduce((s, n, i) => s + cx.get(n.key)! - before[i]!, 0) / row.length / 2
    for (const n of row) out.set(n.key, { x: snap(cx.get(n.key)! - shift) - cardWidth(n) / 2, y })
    y = snap(y + Math.max(...row.map(cardHeight)) + ROW_GAP)
  }
  return out
}

// A free spot under `n`: same column, nudged right past anything already there.
export function spotBelow(g: Graph, n: GraphNode, w: number) {
  const p = n.position!
  const pos = { x: snap(p.x + (cardWidth(n) - w) / 2), y: snap(p.y + cardHeight(n) + ROW_GAP) }
  const hit = () => g.nodes.some(m => m.position && Math.abs(m.position.y - pos.y) < 100 && pos.x < m.position.x + cardWidth(m) + COL_GAP && m.position.x < pos.x + w + COL_GAP)
  while (hit()) pos.x += GRID * 2
  return pos
}

// The step's free way out: null = its one exit is free, a branch key = that branch is free, undefined = none free.
export function freeSlot(g: Graph, n: GraphNode): string | null | undefined {
  if (n.type === 'end') return undefined
  const out = g.edges.filter(e => e.from === n.key)
  if (n.type !== 'condition') return out.length ? undefined : null
  return branchKeys(n).find(b => !out.some(e => e.branch === b))
}

// ---------- palette ----------

export interface PaletteItem { id: string, type: string, label: string, icon: string, preset?: string, outcome?: string }

export const PALETTE: { group: string, items: PaletteItem[] }[] = [
  { group: 'System steps', items: [
    { id: 'cv_parse', type: 'cv_parse', label: 'Read CV', icon: 'scan' },
    { id: 'ai_review', type: 'ai_review', label: 'AI review', icon: 'ai' },
    { id: 'send_email', type: 'send_email', label: 'Email', icon: 'mail' },
  ] },
  { group: 'Decisions', items: [
    { id: 'condition', type: 'condition', label: 'Decision', icon: 'split' },
    { id: 'set_variable', type: 'set_variable', label: 'Set values', icon: 'braces' },
  ] },
  { group: 'Person steps', items: [
    ...Object.entries(HUMAN_TASK_PRESETS).map(([k, p]) => ({ id: k, type: 'human_task', label: p.label, icon: 'person', preset: k })),
    { id: 'person', type: 'human_task', label: 'Custom person step', icon: 'person' },
  ] },
  { group: 'Endings', items: [
    { id: 'hired', type: 'end', label: 'Hired', icon: 'flag', outcome: 'hired' },
    { id: 'rejected', type: 'end', label: 'Rejected', icon: 'flag', outcome: 'rejected' },
    { id: 'withdrawn', type: 'end', label: 'Withdrawn', icon: 'flag', outcome: 'withdrawn' },
  ] },
]

const BASE_KEY: Record<string, string> = { cv_parse: 'read_cv', ai_review: 'ai_review', send_email: 'email', condition: 'decision', set_variable: 'values', person: 'person_step' }

// A new step whose settings already pass validation where that's possible.
export function makeNode(item: PaletteItem, g: Graph, form: FormField[]): GraphNode {
  const key = uniqueKey(item.preset ?? item.outcome ?? BASE_KEY[item.id] ?? item.id, g.nodes.map(n => n.key))
  const owner = { users: [], roles: [], job_owner: true }
  const cv = g.nodes.find(n => n.type === 'cv_parse')
  const config: Record<string, unknown> = {
    cv_parse: { file_field: form.find(f => f.type === 'file')?.key ?? 'cv' },
    ai_review: {
      criteria: [{ key: 'skills_match', label: 'Skills match', description: 'How well the CV matches the must-have skills' }],
      ...(cv && { cv_text_ref: `nodes.${cv.key}.text` }),
    },
    send_email: { subject: 'About your application for {{job.title}}', body: 'Hi {{candidate.first_name}},\n\n' },
    condition: { branches: [{ key: 'yes', label: 'Yes', rule: { ref: 'candidate.email', op: 'exists' } }], on_missing: false },
    set_variable: { fields: [{ key: 'value_1', type: 'string', source: { kind: 'literal', value: '' } }] },
    end: { outcome: item.outcome },
    human_task: item.preset
      ? { ...structuredClone(HUMAN_TASK_PRESETS[item.preset]!.config), assignees: owner }
      : {
          title: 'Review {{candidate.first_name}} {{candidate.last_name}}',
          assignees: owner,
          scorecard: [{ key: 'notes', label: 'Notes', type: 'text', required: true }],
          min_submissions: 1,
          due_days: 3,
        } satisfies HumanTaskConfig,
  }
  return { key, type: item.type, label: item.preset || item.outcome ? item.label : undefined, config: config[item.type] }
}

// ---------- fields ----------

const GROUP_ORDER = ['candidate', 'form', 'job']
// Variable picker groups: Candidate, Form, Job, then each earlier step by its name.
export function groupFields(fields: Field[], g: Graph) {
  const groups = new Map<string, { label: string, fields: { field: Field, label: string }[] }>()
  for (const f of fields) {
    const [root, key] = f.path.split('.')
    const id = root === 'nodes' ? `nodes.${key}` : root!
    const node = root === 'nodes' ? g.nodes.find(n => n.key === key) : undefined
    const label = node ? titleOf(node) : root === 'candidate' ? 'Candidate' : root === 'form' ? 'Form' : 'Job'
    if (!groups.has(id)) groups.set(id, { label, fields: [] })
    groups.get(id)!.fields.push({ field: f, label: node ? f.label.slice(f.label.indexOf(': ') + 2) : f.label })
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (GROUP_ORDER.indexOf(a) + 1 || 9) - (GROUP_ORDER.indexOf(b) + 1 || 9))
    .map(([, v]) => v)
}

const OP_WORDS: Record<Op, string> = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', in: 'is one of', nin: 'is not one of', contains: 'contains', exists: 'has a value',
  is_true: 'is yes', is_false: 'is no',
}
const DATE_WORDS: Partial<Record<Op, string>> = { gt: 'is after', gte: 'is on or after', lt: 'is before', lte: 'is on or before' }
export const opWords = (op: Op, type?: FieldType) => (type === 'date' && DATE_WORDS[op]) || OP_WORDS[op]

// Fills in sample answers for an email preview.
export function sampleContext(fields: Field[], job: { title: string, openings: number, requirements?: object }) {
  const ctx: Record<string, any> = {}
  const sample = (f: Field): unknown => {
    switch (f.type) {
      case 'number': return 72
      case 'boolean': return true
      case 'list': return ['Go', 'PostgreSQL']
      case 'date': return '2026-11-03'
      case 'enum': return f.options?.[0] ?? 'Option'
      case 'text': return 'Eight years building payment systems in Go.'
      case 'file': return undefined
      default: return f.label
    }
  }
  for (const f of fields) {
    const parts = f.path.split('.')
    let cur = ctx
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {}
    cur[parts.at(-1)!] = sample(f)
  }
  ctx.candidate = { first_name: 'Maya', last_name: 'Okafor', email: 'maya.okafor@example.com', phone: '+44 7700 900461' }
  ctx.job = { ...ctx.job, ...job.requirements, title: job.title, openings: job.openings }
  return ctx
}

export const isComparison = (r: Rule): r is Extract<Rule, { ref: string }> => 'ref' in r
