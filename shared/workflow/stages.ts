// Pipeline-first view of a flow: where a move lands, what it sets off, and the flow read as a list of stages. Pure.
// ponytail: imports the one app helper that names steps (pure, no imports); move nodeLabel into shared/ if that ever bites.
import { nodeLabel } from '../../app/utils/nodes'
import { type HumanTaskConfig, OUTCOMES, REGISTRY, conditionBranchKeys } from './registry'
import type { ConditionConfig, Rule } from './rules'
import type { FormField, Graph, GraphEdge, GraphNode } from './types'

export type Outcome = typeof OUTCOMES[number]
// Where a card sits on the board: a step (active) or an outcome (closed). Same shape the moves API takes as `from`.
export type Pos = { node: string } | { closed: 'hired' | 'rejected' | 'withdrawn' }
export type Relation = { kind: 'next', branch?: string } | { kind: 'skip', steps: number } | { kind: 'back' } | { kind: 'other' }

// Resting = a step people wait at: auto (queued work) or human (a task). Trigger and instant steps (condition,
// set_variable) are passed straight through inside one engine transaction; End closes. Same notion as the board.
export const resting = (type: string) => ['auto', 'human'].includes(REGISTRY[type]?.kind ?? '')
const passThrough = (n: GraphNode) => ['trigger', 'instant'].includes(REGISTRY[n.type]?.kind ?? '')
const outcomeOf = (n: GraphNode) => n.type === 'end' ? (n.config as { outcome?: Outcome } | null)?.outcome : undefined

const cond = (n: GraphNode) => (n.config ?? {}) as Partial<ConditionConfig>
const branchLabel = (n: GraphNode, key: string) =>
  key === 'default' ? 'Otherwise' : key === 'missing' ? 'Missing data' : cond(n).branches?.find(b => b.key === key)?.label || key

// Outgoing edges; a condition's in branch order (its own branches, then Otherwise, then Missing data).
function outs(g: Graph, key: string): GraphEdge[] {
  const n = g.nodes.find(x => x.key === key)
  const edges = g.edges.filter(e => e.from === key)
  if (n?.type !== 'condition') return edges
  const order = conditionBranchKeys({ branches: cond(n).branches ?? [], on_missing: !!cond(n).on_missing })
  const rank = (e: GraphEdge) => (order.indexOf(e.branch ?? '') + order.length + 1) % (order.length + 1) // unknown last
  return edges.sort((a, b) => rank(a) - rank(b))
}

// Fewest resting steps passed on the way from `from` to every node (0-1 BFS), with the branch labels of that path.
function reach(g: Graph, from: string) {
  const nodes = new Map(g.nodes.map(n => [n.key, n]))
  const best = new Map<string, { steps: number, branch: string[] }>([[from, { steps: 0, branch: [] }]])
  const queue = [from]
  while (queue.length) {
    const u = queue.shift()!
    const n = nodes.get(u)
    if (!n) continue
    const cur = best.get(u)!
    const cost = u !== from && resting(n.type) ? 1 : 0
    for (const e of outs(g, u)) {
      const steps = cur.steps + cost
      if ((best.get(e.to)?.steps ?? Infinity) <= steps) continue
      best.set(e.to, { steps, branch: n.type === 'condition' && e.branch ? [...cur.branch, branchLabel(n, e.branch)] : cur.branch })
      if (cost) queue.push(e.to)
      else queue.unshift(e.to)
    }
  }
  return best
}

// next: `to` is the first resting step (or End outcome) after `from`; branch = condition labels on the way, joined " · ".
// skip: forward, passing `steps` other resting steps (fewest over all paths). back: `from` is reachable from `to`.
export function relation(graph: Graph, from: Pos, to: Pos): Relation {
  if ('closed' in from || ('node' in to && to.node === from.node)) return { kind: 'other' }
  const fwd = reach(graph, from.node)
  const targets = 'node' in to ? [to.node] : graph.nodes.filter(n => outcomeOf(n) === to.closed).map(n => n.key)
  const hit = targets.map(k => fwd.get(k)).filter(h => !!h).sort((a, b) => a.steps - b.steps)[0]
  if (hit) return hit.steps ? { kind: 'skip', steps: hit.steps } : { kind: 'next', ...(hit.branch.length ? { branch: hit.branch.join(' · ') } : {}) }
  if ('node' in to && reach(graph, to.node).has(from.node)) return { kind: 'back' }
  return { kind: 'other' }
}

// `text` is ready to show. Human tasks also carry `assignees` (raw user/role ids: the UI resolves names) and `dueDays`.
export interface Effect {
  kind: 'assign' | 'booking' | 'auto' | 'email' | 'close'
  text: string
  nodeKey?: string
  outcome?: Outcome // close: how they end, so a move that ends in a rejection can ask why
  assignees?: HumanTaskConfig['assignees']
  dueDays?: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// What one resting step does, in the recruiter's words.
function stepEffects(n: GraphNode): Effect[] {
  const nodeKey = n.key
  const name = nodeLabel(n)
  switch (n.type) {
    case 'cv_parse': return [{ kind: 'auto', text: 'Reads their CV', nodeKey }]
    case 'ai_review': return [{ kind: 'auto', text: 'Runs AI screening', nodeKey }]
    case 'ai_check': return [{ kind: 'auto', text: 'Checks their answers with AI', nodeKey }]
    case 'send_email': return [{ kind: 'email', text: `Sends them “${name}”`, nodeKey }]
    case 'request_documents': // assignees and due_days read the same as a person step's
    case 'human_task': {
      const c = (n.config ?? {}) as Partial<HumanTaskConfig> & { booking?: { duration_min: number } }
      const a = { users: c.assignees?.users ?? [], roles: c.assignees?.roles ?? [], job_owner: !!c.assignees?.job_owner }
      const who = [
        a.job_owner && 'the job owner',
        a.users.length && plural(a.users.length, 'person', 'people'),
        a.roles.length && `everyone in ${plural(a.roles.length, 'role')}`,
      ].filter(Boolean).join(' and ') || 'nobody yet'
      const due = c.due_days === undefined ? '' : c.due_days === 0 ? ', due today' : `, due in ${plural(c.due_days, 'day')}`
      const panel = (c.min_submissions ?? 1) > 1 ? `, ${c.min_submissions} answers needed` : ''
      const out: Effect[] = [{ kind: 'assign', text: `“${name}” goes to ${who}${due}${panel}`, nodeKey, assignees: a, dueDays: c.due_days }]
      if (c.booking) out.push({ kind: 'booking', text: `They’re asked to book a ${c.booking.duration_min}-minute slot`, nodeKey })
      return out
    }
  }
  return resting(n.type) ? [{ kind: 'auto', text: `Runs “${name}”`, nodeKey }] : []
}

// What a manual move sets off (engine moveApplication → activate): a close just stops everything; a move runs the
// step and walks on through automatic steps until a person, a decision (its branch depends on data) or an End.
export function arrivalEffects(graph: Graph, to: Pos): Effect[] {
  if ('closed' in to) return [{ kind: 'close', outcome: to.closed, text: `Closes them as ${to.closed}. Their current step stops and open tasks are taken back. No email is sent.` }]
  const out: Effect[] = []
  const seen = new Set<string>()
  for (let key: string | undefined = to.node; key && !seen.has(key);) {
    seen.add(key)
    const n = graph.nodes.find(x => x.key === key)
    if (!n || n.type === 'condition') break
    const outcome = outcomeOf(n)
    if (outcome) {
      out.push({ kind: 'close', text: `Then closes them as ${outcome}`, nodeKey: key, outcome })
      break
    }
    out.push(...stepEffects(n).map(e => e.kind === 'email' ? { ...e, text: `${e.text}. It can’t be unsent.` } : e))
    if (REGISTRY[n.type]?.kind === 'human') break
    key = graph.edges.find(e => e.from === key)?.to
  }
  return out
}

// Reverse post-order DFS from the trigger: a topological order on a DAG, first branch first. Unreachable nodes last.
function flowOrder(g: Graph) {
  const seen = new Set<string>()
  const post: string[] = []
  const visit = (k: string) => {
    if (seen.has(k)) return
    seen.add(k)
    for (const e of outs(g, k).reverse()) visit(e.to)
    post.push(k)
  }
  const trigger = g.nodes.find(n => REGISTRY[n.type]?.kind === 'trigger')
  if (trigger) visit(trigger.key)
  return [...post.reverse(), ...g.nodes.map(n => n.key).filter(k => !seen.has(k))]
}

const stageSteps = (g: Graph, keys: string[]) => {
  const inStage = new Set(keys)
  return flowOrder(g).map(k => g.nodes.find(n => n.key === k)!).filter(n => inStage.has(n.key) && resting(n.type))
}

// The ⚡ line of a board column: each resting step of the stage, in flow order.
export function stageSummary(graph: Graph, stageId: string): Effect[] {
  const stage = graph.stages?.find(s => s.id === stageId)
  return stage ? stageSteps(graph, stage.nodeKeys).flatMap(stepEffects) : []
}

export interface StageStep { key: string, type: string, effects: Effect[] }
// One way out of a stage. No condition = a plain edge. `to.stage` is the destination's stage (null = in no stage;
// the stage's own id = a move inside the stage, e.g. "Otherwise → Manual review").
export interface StageExit {
  condition?: string
  branch?: string
  label?: string // "Shortlist", "Otherwise", "Missing data"
  rule?: Rule // absent for Otherwise / Missing data
  to: { stage: string | null, node: string } | { closed: Outcome }
}
export interface StageInfo { id: string, name: string, ask?: FormField[], auto: StageStep[], people: StageStep[], exits: StageExit[] }
export interface StageView {
  fits: boolean // false: the flow can't be drawn honestly as a stage list; show `reason` and offer the canvas
  reason?: string
  start: { key: string, exits: StageExit[] } | null // the Applied step and where people go from it
  stages: StageInfo[] // board column order
  unstaged: StageStep[] // resting steps in no stage, flow order
  closed: { outcome: Outcome, ends: string[] }[] // all three outcomes, with the End steps that close into each
}

export function stageView(graph: Graph): StageView {
  const problems: string[] = []
  const nodes = new Map(graph.nodes.map(n => [n.key, n]))
  const stages = graph.stages ?? []
  const stageOf = new Map<string, string>()
  for (const s of stages) {
    for (const k of s.nodeKeys) {
      const other = stageOf.get(k)
      if (other && other !== s.id) problems.push(`“${nodeLabel(nodes.get(k) ?? { key: k, type: '' })}” is in two stages.`)
      stageOf.set(k, s.id)
    }
  }
  const step = (n: GraphNode): StageStep => ({ key: n.key, type: n.type, effects: stepEffects(n) })

  // Ways out of a step, walking through decisions and other pass-through steps to the next resting step or End.
  const exitsFrom = (key: string) => {
    const res: StageExit[] = []
    const seen = new Set([key])
    const walk = (k: string, via: Omit<StageExit, 'to'>) => {
      const src = nodes.get(k)!
      for (const e of outs(graph, k)) {
        const n = nodes.get(e.to)
        if (!n || seen.has(n.key)) continue
        let v = via
        if (src.type === 'condition' && e.branch) {
          if (via.condition) problems.push(`Two decisions in a row after “${nodeLabel(nodes.get(key)!)}”.`)
          const rule = cond(src).branches?.find(b => b.key === e.branch)?.rule
          v = { condition: k, branch: e.branch, label: branchLabel(src, e.branch), ...(rule ? { rule } : {}) }
        }
        const outcome = outcomeOf(n)
        if (outcome) res.push({ ...v, to: { closed: outcome } })
        else if (passThrough(n)) seen.add(n.key), walk(n.key, v)
        else res.push({ ...v, to: { stage: stageOf.get(n.key) ?? null, node: n.key } })
      }
    }
    walk(key, {})
    return res
  }

  const index = new Map(stages.map((s, i) => [s.id, i]))
  const view = stages.map((s): StageInfo => {
    const steps = stageSteps(graph, s.nodeKeys)
    const exits = new Map<string, StageExit>()
    for (const n of steps) {
      for (const x of exitsFrom(n.key)) {
        const dest = 'closed' in x.to ? `c:${x.to.closed}` : `n:${x.to.node}`
        if (!('closed' in x.to) && x.to.stage && index.get(x.to.stage)! < index.get(s.id)!) {
          problems.push(`${x.label ? `“${x.label}” after ` : ''}“${nodeLabel(n)}” sends people back to ${stages[index.get(x.to.stage)!]!.name}.`)
        }
        exits.set(`${x.condition}:${x.branch}:${dest}`, x)
      }
    }
    return {
      id: s.id,
      name: s.name,
      ...(s.ask ? { ask: s.ask } : {}),
      auto: steps.filter(n => REGISTRY[n.type]?.kind !== 'human').map(step),
      people: steps.filter(n => REGISTRY[n.type]?.kind === 'human').map(step),
      exits: [...exits.values()],
    }
  })

  const unstaged = flowOrder(graph).map(k => nodes.get(k)!).filter(n => resting(n.type) && !stageOf.has(n.key))
  for (const n of unstaged) problems.push(`“${nodeLabel(n)}” isn’t in any stage.`)
  if (!stages.length) problems.unshift('This workflow has no stages yet.')
  const trigger = graph.nodes.find(n => REGISTRY[n.type]?.kind === 'trigger')

  return {
    fits: !problems.length,
    ...(problems.length ? { reason: problems[0] } : {}),
    start: trigger ? { key: trigger.key, exits: exitsFrom(trigger.key) } : null,
    stages: view,
    unstaged: unstaged.map(step),
    closed: OUTCOMES.map(outcome => ({ outcome, ends: graph.nodes.filter(n => outcomeOf(n) === outcome).map(n => n.key) })),
  }
}

// Put `node` right after `afterKey`, taking over its single way out. The new step joins afterKey's stage (or, when
// afterKey is in none, e.g. the start, the stage of the step that followed it). Throws on misuse: these are UI bugs.
export function insertAfter(graph: Graph, afterKey: string, node: GraphNode): Graph {
  if (!graph.nodes.some(n => n.key === afterKey)) throw new Error(`no step "${afterKey}"`)
  if (graph.nodes.some(n => n.key === node.key)) throw new Error(`step "${node.key}" already exists`)
  const out = graph.edges.filter(e => e.from === afterKey)
  if (out.length > 1) throw new Error(`"${afterKey}" has more than one way out`)
  const next = out[0]?.to
  const edges = graph.edges.map(e => e === out[0] ? { from: afterKey, to: node.key } : e)
  if (!out.length) edges.push({ from: afterKey, to: node.key })
  if (next) edges.push({ from: node.key, to: next, ...(node.type === 'condition' ? { branch: 'default' } : {}) })
  const host = graph.stages?.find(s => s.nodeKeys.includes(afterKey)) ?? graph.stages?.find(s => next && s.nodeKeys.includes(next))
  return {
    ...graph,
    nodes: [...graph.nodes, node],
    edges,
    ...(graph.stages && {
      stages: graph.stages.map((s) => {
        if (s !== host) return s
        const i = s.nodeKeys.indexOf(afterKey)
        return { ...s, nodeKeys: i < 0 ? [node.key, ...s.nodeKeys] : [...s.nodeKeys.slice(0, i + 1), node.key, ...s.nodeKeys.slice(i + 1)] }
      }),
    }),
  }
}

// Take out a step with one way out, pointing everything that led to it at its successor. null when that isn't safe:
// start, End, decisions, more or less than one way out, a loop, or another step reads its answers (nodes.<key>.*).
export function removeStep(graph: Graph, key: string): Graph | null {
  const n = graph.nodes.find(x => x.key === key)
  if (!n || !resting(n.type)) return null
  const out = graph.edges.filter(e => e.from === key)
  const ins = graph.edges.filter(e => e.to === key)
  if (out.length !== 1 || !ins.length) return null
  const next = out[0]!.to
  if (next === key || ins.some(e => e.from === next)) return null
  if (graph.nodes.some(x => x.key !== key && JSON.stringify(x.config ?? {}).includes(`nodes.${key}.`))) return null
  return {
    ...graph,
    nodes: graph.nodes.filter(x => x.key !== key),
    edges: graph.edges.filter(e => e.from !== key).map(e => e.to === key ? { ...e, to: next } : e),
    ...(graph.stages && { stages: graph.stages.map(s => ({ ...s, nodeKeys: s.nodeKeys.filter(k => k !== key) })) }),
  }
}

// Candidate status page. A flow email sent right before an End closes them (the flow's own rejection or welcome email).
export const endsFlow = (graph: Graph, nodeKey: string | null) =>
  !!nodeKey && graph.edges.some(e => e.from === nodeKey && graph.nodes.find(n => n.key === e.to)?.type === 'end')

// "Applied", then each stage's candidate name; neighbours with the same name merge into one step. A stage that only
// closes (Standard hire's "Not moving on") is no step on the way, so it isn't shown.
export function candidateSteps(graph: Graph) {
  const hidden = new Set<string>()
  const steps = ['Applied']
  const at = new Map<string, number>() // stage id → step index
  for (const s of graph.stages ?? []) {
    if (s.nodeKeys.length && s.nodeKeys.every(k => endsFlow(graph, k))) {
      hidden.add(s.id)
      continue
    }
    const name = s.candidateName?.trim() || 'In review'
    if (steps.at(-1) !== name) steps.push(name)
    at.set(s.id, steps.length - 1)
  }
  return { steps, hidden, stepOf: (nodeKey: string | null) => {
    const s = nodeKey ? graph.stages?.find(x => x.nodeKeys.includes(nodeKey)) : undefined
    return s ? at.get(s.id) : undefined
  } }
}
