import { z } from 'zod'
import { CORE_FIELDS, formFieldSchema, formFields, formSchemaDef, validateForm } from './form'
import { type NodeDef, REGISTRY, conditionBranchKeys } from './registry'
import type { ConditionConfig } from './rules'
import { render } from './template'
import { type Field, type FormField, type Graph, type GraphNode, type Issue, KEY_RE } from './types'
import { nodeLabel } from '../../app/utils/nodes'

// Shape only. Drafts are saved with this (they may be invalid); publish runs validateVersion.
export const graphSchema = z.object({
  nodes: z.array(z.object({
    key: z.string().min(1).max(40),
    type: z.string().min(1),
    config: z.unknown(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    label: z.string().max(100).optional(),
  })).max(200),
  edges: z.array(z.object({ from: z.string(), to: z.string(), branch: z.string().optional() })).max(400),
  stages: z.array(z.object({
    id: z.string().min(1).max(40),
    name: z.string().trim().min(1).max(40),
    nodeKeys: z.array(z.string()).max(200),
    ask: z.array(formFieldSchema).max(10).optional(),
  })).max(30).optional(),
}) satisfies z.ZodType<Graph>

export const JOB_FIELDS: Field[] = [
  { path: 'job.title', type: 'string', label: 'Job title' },
  { path: 'job.min_experience_years', type: 'number', label: 'Minimum years of experience' },
  { path: 'job.must_have_skills', type: 'list', label: 'Must-have skills' },
  { path: 'job.salary_min', type: 'number', label: 'Salary min' },
  { path: 'job.salary_max', type: 'number', label: 'Salary max' },
  { path: 'job.location', type: 'string', label: 'Location' },
  { path: 'job.employment_type', type: 'string', label: 'Employment type' },
  { path: 'job.openings', type: 'number', label: 'Openings' },
]

interface Parsed { node: GraphNode, def?: NodeDef, config?: unknown }

function parseNodes(graph: Graph) {
  const nodes = new Map<string, Parsed>()
  for (const node of graph.nodes) {
    const def = REGISTRY[node.type]
    const res = def?.config.safeParse(node.config ?? {})
    nodes.set(node.key, { node, def, config: res?.success ? res.data : undefined })
  }
  return nodes
}

// Kahn's algorithm. Returns null when the graph has a cycle.
function topoOrder(keys: string[], edges: Graph['edges']): string[] | null {
  const indeg = new Map(keys.map(k => [k, 0]))
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  const queue = keys.filter(k => indeg.get(k) === 0)
  const order: string[] = []
  while (queue.length) {
    const k = queue.shift()!
    order.push(k)
    for (const e of edges) {
      if (e.from !== k) continue
      indeg.set(e.to, indeg.get(e.to)! - 1)
      if (indeg.get(e.to) === 0) queue.push(e.to)
    }
  }
  return order.length === keys.length ? order : null
}

// Nodes on *every* path from the trigger to each node: only their outputs are safe to read.
function dominators(order: string[], edges: Graph['edges'], trigger: string) {
  const dom = new Map<string, Set<string>>([[trigger, new Set()]])
  for (const k of order) {
    if (k === trigger) continue
    const preds = edges.filter(e => e.to === k && dom.has(e.from)).map(e => e.from)
    if (!preds.length) continue // unreachable
    const sets = preds.map(p => new Set([...dom.get(p)!, p]))
    dom.set(k, new Set([...sets[0]!].filter(x => sets.every(s => s.has(x)))))
  }
  return dom
}

const outputsOf = (p: Parsed): Field[] =>
  p.def && p.config !== undefined
    ? p.def.outputs(p.config).map(o => ({ path: `nodes.${p.node.key}.${o.key}`, type: o.type, label: `${nodeLabel(p.node)}: ${o.label}`, nodeType: p.node.type, ...(o.options && { options: o.options }), ...(o.rule === false && { rule: false as const }) }))
    : []

const baseFields = (form: FormField[]) => [...CORE_FIELDS, ...formFields(form), ...JOB_FIELDS]

// Variable picker: what a node may read. Empty for nodes that are unreachable or in a cycle.
export function fieldsAvailableAt(graph: Graph, nodeKey: string, form: FormField[]): Field[] {
  const parsed = parseNodes(graph)
  const trigger = graph.nodes.find(n => REGISTRY[n.type]?.kind === 'trigger')
  const order = topoOrder([...parsed.keys()], graph.edges.filter(e => parsed.has(e.from) && parsed.has(e.to)))
  if (!trigger || !order) return baseFields(form)
  const dom = dominators(order, graph.edges, trigger.key).get(nodeKey)
  if (!dom) return []
  return [...baseFields(form), ...[...dom].flatMap(k => outputsOf(parsed.get(k)!))]
}

// Every rule from the plan, section 6 of the reference. Publish requires [].
export function validateGraph(graph: Graph, form: FormField[]): Issue[] {
  const issues: Issue[] = []
  const add = (node: string | undefined, code: string, message: string) => issues.push({ node, code, message })

  // nodes: keys, types, configs
  const seen = new Set<string>()
  for (const n of graph.nodes) {
    if (!KEY_RE.test(n.key)) add(n.key, 'bad_key', `node key "${n.key}" must be snake_case, start with a letter, max 40`)
    if (seen.has(n.key)) add(n.key, 'duplicate_node', `node key "${n.key}" is used twice`)
    seen.add(n.key)
    const def = REGISTRY[n.type]
    if (!def) {
      add(n.key, 'unknown_type', `unknown node type "${n.type}"`)
      continue
    }
    const res = def.config.safeParse(n.config ?? {})
    if (!res.success) for (const i of res.error.issues) add(n.key, 'invalid_config', `${i.path.join('.') || 'config'}: ${i.message}`)
  }
  const parsed = parseNodes(graph)

  const triggers = graph.nodes.filter(n => REGISTRY[n.type]?.kind === 'trigger')
  if (triggers.length !== 1) add(undefined, 'trigger_count', `a workflow needs exactly one trigger, found ${triggers.length}`)
  const trigger = triggers[0]

  // edges
  const edges = graph.edges.filter((e) => {
    if (!parsed.has(e.from) || !parsed.has(e.to)) return add(e.from, 'dangling_edge', `edge ${e.from} → ${e.to} points at a missing node`), false
    if (e.from === e.to) return add(e.from, 'self_loop', `node "${e.from}" connects to itself`), false
    return true
  })
  if (trigger && edges.some(e => e.to === trigger.key)) add(trigger.key, 'trigger_incoming', 'the trigger cannot have incoming edges')

  for (const [key, p] of parsed) {
    const out = edges.filter(e => e.from === key)
    const kind = p.def?.kind
    if (!kind) continue
    if (kind === 'terminal') {
      if (out.length) add(key, 'end_outgoing', 'an End node cannot have outgoing edges')
    }
    else if (p.node.type === 'condition') {
      if (!p.config) continue // config issues already reported
      const expected = conditionBranchKeys(p.config as ConditionConfig)
      for (const b of expected) {
        const n = out.filter(e => e.branch === b).length
        if (n !== 1) add(key, 'branch_edges', `branch "${b}" needs exactly one outgoing edge, has ${n}`)
      }
      for (const e of out) if (!e.branch || !expected.includes(e.branch)) add(key, 'unknown_branch', `edge to "${e.to}" has no matching branch`)
    }
    else {
      if (out.length !== 1) add(key, 'out_edges', `needs exactly one outgoing edge, has ${out.length}`)
      if (out.some(e => e.branch)) add(key, 'unexpected_branch', 'only condition edges carry a branch')
    }
  }

  const order = topoOrder([...parsed.keys()], edges)
  if (!order) add(undefined, 'cycle', 'the workflow has a loop; loops are not supported yet')
  if (!trigger || !order) return issues

  // reachability (with one outgoing edge per non-end node and no cycles, every path then ends at an End)
  const reached = new Set([trigger.key])
  const stack = [trigger.key]
  while (stack.length) {
    const k = stack.pop()!
    for (const e of edges) if (e.from === k && !reached.has(e.to)) reached.add(e.to), stack.push(e.to)
  }
  for (const k of parsed.keys()) if (!reached.has(k)) add(k, 'unreachable', 'cannot be reached from the trigger')

  // refs: each node may only read fields guaranteed to exist upstream
  const dom = dominators(order, edges, trigger.key)
  const base = baseFields(form)
  for (const [key, p] of parsed) {
    if (!p.def?.check || p.config === undefined || !dom.has(key)) continue
    const available = new Map([...base, ...[...dom.get(key)!].flatMap(k => outputsOf(parsed.get(k)!))].map(f => [f.path, f]))
    issues.push(...p.def.check(p.config, available, key))
  }
  return issues
}

// Form + workflow publish together.
export function validateVersion(form: unknown, graph: unknown): Issue[] {
  const formIssues = validateForm(form)
  const formOk = formSchemaDef.safeParse(form)
  const g = graphSchema.safeParse(graph)
  if (!g.success) return [...formIssues, ...g.error.issues.map(i => ({ code: 'invalid_graph', message: `workflow.${i.path.join('.')}: ${i.message}` }))]
  return [...formIssues, ...validateGraph(g.data, formOk.success ? formOk.data : [])]
}

// Keys are immutable across versions: a form field, node, or node output key may disappear and
// come back, but always with the type it first had. Reports and timelines compare by key across
// versions, and in-flight applications on old versions hold values of the old type.
function keyTypes(v: { form: FormField[], workflow: Graph }) {
  const types = new Map<string, { type: string, node?: string }>()
  for (const f of v.form) types.set(`form.${f.key}`, { type: f.type })
  for (const p of parseNodes(v.workflow).values()) {
    types.set(`node:${p.node.key}`, { type: p.node.type, node: p.node.key })
    for (const f of outputsOf(p)) types.set(f.path, { type: f.type, node: p.node.key })
  }
  return types
}

export function checkVersionCompat(previous: { form: FormField[], workflow: Graph }[], next: { form: FormField[], workflow: Graph }): Issue[] {
  const history = new Map<string, string>()
  for (const v of previous) for (const [k, t] of keyTypes(v)) if (!history.has(k)) history.set(k, t.type)
  const issues: Issue[] = []
  for (const [k, t] of keyTypes(next)) {
    const was = history.get(k)
    if (!was || was === t.type) continue
    const name = k.startsWith('node:') ? `node "${k.slice(5)}"` : `"${k}"`
    issues.push({ node: t.node, code: k.startsWith('form.') ? 'field_type_changed' : 'node_type_changed', message: `${name} was ${was} in an earlier version; use a new key for a ${t.type}` })
  }
  return issues
}

// The flow's rejection email: a send_email step that leads straight to a rejected End. A manual reject can send it.
export const rejectionEmailNode = (g: Graph): GraphNode | undefined => g.nodes.find(n => n.type === 'send_email' && g.edges.some((e) => {
  const to = e.from === n.key && g.nodes.find(m => m.key === e.to)
  return to && to.type === 'end' && (to.config as { outcome?: string } | null)?.outcome === 'rejected'
}))

// Not blocking, but likely a mistake: an AI step with nothing to read, or an AI review with nothing to score against.
// Run on a well-formed version (after validateVersion passes).
export function aiWarnings(graph: Graph, form: FormField[], requirements: { must_have_skills?: string[], min_experience_years?: number } | null): Issue[] {
  const out: Issue[] = []
  const answers = form.some(f => !f.protected && f.type !== 'file')
  const noReqs = !requirements?.must_have_skills?.length && requirements?.min_experience_years === undefined
  for (const n of graph.nodes) {
    if (n.type !== 'ai_review' && n.type !== 'ai_check') continue
    const name = nodeLabel(n)
    // cv_text_ref is the only way CV text reaches the AI (a Read CV output, or a pasted-CV text field)
    const cv = !!(n.config as { cv_text_ref?: string } | undefined)?.cv_text_ref
    if (n.type === 'ai_review' && !cv) out.push({ node: n.key, code: 'ai_no_cv', message: `${name} has no CV to read, so it scores the form answers only. Add a CV file field and a Read CV step, then pick it under “CV text from”.` })
    if (n.type === 'ai_check' && !cv && !answers) out.push({ node: n.key, code: 'ai_nothing_to_read', message: `${name} has nothing to read: no CV text and no form answers.` })
    if (n.type === 'ai_review' && noReqs) out.push({ node: n.key, code: 'ai_no_requirements', message: `${name} has nothing to score against. Add must-have skills or minimum years in Details.` })
  }
  return out
}

// What a manual reject's email is called, for the "Send them the rejection email" checkbox (domain/emails.ts has the default).
export const rejectionSubject = (g: Graph | null | undefined, jobTitle: string) => {
  const n = g && rejectionEmailNode(g)
  return n ? render((n.config as { subject: string }).subject, { job: { title: jobTitle } }) : `Your application for ${jobTitle}`
}
