// relative, not ~~, so test/board.test.ts can import this file without the Nuxt aliases
import { type Effect, type Pos, arrivalEffects, relation, resting, stageSummary } from '../../shared/workflow/stages'
import type { Graph } from '../../shared/workflow/types'
import type { Board, PipelineRow } from '../pages/jobs/[id].vue'
import { nodeLabel } from '../utils/nodes'

// The list row as the API sends it now; the shared PipelineRow type predates these three fields.
export type ListRow = PipelineRow & { source: string | null, score: number | null, since: string | null }
export const posOfRow = (r: PipelineRow): Pos | null =>
  r.status === 'closed' ? { closed: r.outcome as 'hired' } : r.currentNodeKey ? { node: r.currentNodeKey } : null
// "3d here": how long someone has waited where they are; the board and list say it the same way
export function inStep(since: string | null, now = Date.now()) {
  if (!since) return ''
  const d = Math.floor((now - new Date(since).getTime()) / 86_400_000)
  return d < 1 ? 'Arrived today' : `${d}d here`
}

export type { Pos }
export { resting }
export interface Person { id: string, name: string, email: string, at: Pos }
export interface Row { id: string, pos: Pos, label: string, type?: string }
export const posId = (p: Pos) => 'node' in p ? `n:${p.node}` : `c:${p.closed}`

// Board columns, also the targets of every move picker: stages, then steps no stage claims, then Closed.
export function boardColumns(board: Pick<Board, 'stages' | 'steps'>) {
  const stepRow = (s: Board['steps'][number]): Row => ({ id: `n:${s.key}`, pos: { node: s.key }, label: nodeLabel(s), type: s.type })
  const steps = board.steps.filter(s => resting(s.type))
  const byKey = new Map(steps.map(s => [s.key, s]))
  const claimed = new Set<string>()
  const cols: { id: string, name: string, stage: boolean, rows: Row[] }[] = []
  for (const st of board.stages ?? []) {
    const rows = st.nodeKeys.flatMap(k => byKey.has(k) && !claimed.has(k) ? (claimed.add(k), [stepRow(byKey.get(k)!)]) : [])
    cols.push({ id: st.id, name: st.name, stage: true, rows })
  }
  const rest = steps.filter(s => !claimed.has(s.key))
  // no stages at all: one column per step, the plain kanban
  if (!board.stages?.length) for (const s of rest) cols.push({ id: s.key, name: nodeLabel(s), stage: false, rows: [stepRow(s)] })
  else if (rest.length) cols.push({ id: 'other', name: 'Other steps', stage: false, rows: rest.map(stepRow) })
  cols.push({ id: 'closed', name: 'Closed', stage: false, rows: (['hired', 'rejected', 'withdrawn'] as const).map(o => ({ id: `c:${o}`, pos: { closed: o }, label: o[0]!.toUpperCase() + o.slice(1) })) })
  return cols
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// The label a target wears while a card is dragged over the board. `next` = the flow's own way on,
// so the move needs no reason; a reject always asks for one from the team's list.
export type TagKind = 'next' | 'skip' | 'back' | 'close' | 'other'
export function dropTag(graph: Graph | null, from: Pos, to: Pos): { kind: TagKind, text: string } {
  const r = graph ? relation(graph, from, to) : { kind: 'other' as const }
  const asks = 'closed' in to && to.closed === 'rejected' ? ' · asks a reason' : ''
  if (r.kind === 'next') return { kind: 'next', text: `Next${r.branch ? ` · “${r.branch}”` : ''}${asks}` }
  if ('closed' in to) {
    if (to.closed === 'withdrawn') return { kind: 'close', text: 'Any step can close here' }
    return { kind: 'close', text: `Close as ${to.closed}${asks}` }
  }
  if ('closed' in from) return { kind: 'other', text: 'Reopens here' }
  if (r.kind === 'skip') return { kind: 'skip', text: `Skips ${plural(r.steps, 'step')}` }
  if (r.kind === 'back') return { kind: 'back', text: 'Goes back' }
  return { kind: 'other', text: 'Off the usual path' }
}

// A free-text reason is needed unless the move is the flow's own next step. A reject takes a listed reason instead.
export const needsReason = (graph: Graph | null, from: Pos, to: Pos) =>
  !('closed' in to && to.closed === 'rejected') && dropTag(graph, from, to).kind !== 'next'

// Names for the people a task goes to; ids we can't resolve stay as a count (the shared text already says it).
type Names = (id: string) => string | undefined
export function effectText(e: Effect, nameOf: Names, many = false) {
  let text = e.text
  const ids = e.assignees?.users ?? []
  const names = ids.map(nameOf)
  // ponytail: swaps the "N people" that stepEffects writes; breaks quietly (keeps the count) if that wording changes
  if (ids.length && names.every(Boolean)) text = text.replace(plural(ids.length, 'person', 'people'), names.join(', '))
  return many && e.kind === 'assign' ? `${text}, one for each of them` : text
}

export const dropEffects = (graph: Graph | null, to: Pos, nameOf: Names, many = false) =>
  graph ? arrivalEffects(graph, to).map(e => ({ kind: e.kind, outcome: e.outcome, text: effectText(e, nameOf, many) })) : []

// The ⚡ line under a column title: what the stage does by itself, short, as you'd tell a colleague.
export function boltLine(graph: Graph | null, stageId: string, nameOf: Names) {
  if (!graph) return ''
  const first = (id: string) => nameOf(id)?.split(/\s+/)[0]
  const parts = stageSummary(graph, stageId).map((e) => {
    const type = graph.nodes.find(n => n.key === e.nodeKey)?.type
    if (e.kind === 'assign') {
      const a = e.assignees
      const users = (a?.users ?? []).map(first)
      const who = [
        ...(users.every(Boolean) ? users : users.length ? [plural(users.length, 'person', 'people')] : []),
        a?.job_owner && 'the job owner',
        a?.roles.length && plural(a.roles.length, 'role'),
      ].filter(Boolean)
      return who.length ? `Assigns ${who.join(', ')}` : 'Assigns nobody yet'
    }
    if (e.kind === 'booking') return 'booking link'
    if (type === 'cv_parse') return 'Reads the CV'
    if (type === 'ai_review') return 'AI scores them'
    if (type === 'ai_check') return 'AI checks their answers'
    if (e.kind === 'email') return e.text.replace('Sends them', 'Emails')
    return e.text
  })
  return parts.join(' · ')
}

// The list's AI score filter, as presets a person picks without typing numbers.
export const SCORE_BANDS = [
  { value: '', label: 'Any AI score' },
  { value: '70', label: 'AI score 70+', min: 70 },
  { value: '40', label: 'AI score 40–69', min: 40, max: 69.999 },
  { value: '0', label: 'AI score under 40', max: 39.999 },
] as const
