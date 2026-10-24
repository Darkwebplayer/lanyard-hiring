<script lang="ts">
import { CORE_FIELDS } from '~~/shared/workflow/form'
import { JOB_FIELDS } from '~~/shared/workflow/graph'
import type { Graph } from '~~/shared/workflow/types'
import { type ConditionEvaluation, type Op, type TraceEntry, VALUELESS } from '~~/shared/workflow/rules'

// GET /api/applications/:id (docs/backend.md, Operations). input/output/evaluation are managers only.
export interface Assignment { userId: string, name: string, assignedAt: string, submittedAt: string | null, closedAt: string | null, values: Record<string, unknown> | null }
export interface Run {
  id: string, nodeKey: string, nodeType: string, attempt: number, status: string, branchTaken: string | null
  error: string | null, retries: number, dueAt: string | null, overdue: boolean, actorId: string | null
  createdAt: string, completedAt: string | null
  input?: unknown, output?: Record<string, unknown> | null, evaluation?: ConditionEvaluation | null
  assignments: Assignment[]
}
export interface TimelineEvent { id: string, type: string, data: any, createdAt: string, actorId: string | null, actorName: string | null }
export interface Timeline {
  application: { id: string, status: 'active' | 'closed', outcome: string | null, currentNodeKey: string | null, createdAt: string, answers: Record<string, any>
    source?: string | null, consent?: { text: string, at: string } | null }
  candidate: { firstName: string, lastName: string, email: string, phone: string | null }
  job: { id: string, title: string }
  version: number
  form: { key: string, label: string, type: string }[]
  nodes: { key: string, type: string, label?: string | null }[]
  graph?: Graph // managers only: the pinned flow version
  runs: Run[]
  events: TimelineEvent[]
}

export const humanise = (k: string) => {
  const s = k.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Standard-hire steps have no label, so fall back to the key ("manual_review" → "Manual review"), not the
// type name ("Human task"); short keys like "ai" or "cv" read better as the step's noun ("AI review").
export function stepName(tl: Timeline, key: string) {
  const n = tl.nodes.find(n => n.key === key)
  return n ? nodeLabel(n) : humanise(key)
}

const FIXED: Record<string, string> = Object.fromEntries([...CORE_FIELDS, ...JOB_FIELDS].map(f => [f.path, f.label]))

// "nodes.ai.overall" → "AI review · Overall" (in a sentence: "AI review overall")
export function refLabel(tl: Timeline, ref: string, inSentence = false) {
  if (FIXED[ref]) return FIXED[ref]
  const [head, a = '', b] = ref.split('.')
  if (head === 'nodes') return !b ? stepName(tl, a) : inSentence ? `${stepName(tl, a)} ${humanise(b).toLowerCase()}` : `${stepName(tl, a)} · ${humanise(b)}`
  if (head === 'form') return tl.form.find(f => f.key === a)?.label ?? humanise(a)
  return humanise(ref.split('.').pop()!)
}

export function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v)) return v.map(fmtVal).join(', ')
  if (typeof v === 'number') return String(Math.round(v * 100) / 100)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return fmtDate(v)
  return String(v)
}

const OP_TEXT: Record<Op, string> = {
  eq: 'is', neq: 'isn’t', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', in: 'is one of', nin: 'isn’t one of',
  contains: 'contains', exists: 'is filled in', is_true: 'is yes', is_false: 'is no',
}
const expectedText = (e: TraceEntry) =>
  e.op === 'between' && Array.isArray(e.expected) ? `${fmtVal(e.expected[0])} and ${fmtVal(e.expected[1])}` : fmtVal(e.expected)

// One comparison as a line: "AI review · Overall (38) ≥ 70"
export function traceText(tl: Timeline, e: TraceEntry) {
  const label = refLabel(tl, e.ref)
  if (VALUELESS.includes(e.op)) return `${label} ${OP_TEXT[e.op]}`
  return `${label}${e.missing ? '' : ` (${fmtVal(e.actual)})`} ${OP_TEXT[e.op]} ${expectedText(e)}`
}

// A comparison that held, as a reason: "AI review overall was 38, below 40"
export function reasonText(tl: Timeline, e: TraceEntry) {
  const label = refLabel(tl, e.ref, true)
  const was = `${label} was ${fmtVal(e.actual)}`
  const x = expectedText(e)
  switch (e.op) {
    case 'is_true': return `${label} was yes`
    case 'is_false': return `${label} was no`
    case 'exists': return `${label} was filled in`
    case 'gt': return `${was}, above ${x}`
    case 'gte': return `${was}, at least ${x}`
    case 'lt': return `${was}, below ${x}`
    case 'lte': return `${was}, at most ${x}`
    case 'neq': return `${was}, not ${x}`
    case 'between': return `${was}, between ${x}`
    case 'nin': return `${was}, not one of ${x}`
    case 'contains': return `${label} included “${x}”`
    default: return was
  }
}
</script>

<script setup lang="ts">
// Every branch of a decision with each comparison it made, so the path taken can be checked by eye.
const props = defineProps<{ tl: Timeline, run: Run }>()
const ev = computed(() => props.run.evaluation!)
const dest = computed(() => {
  const next = props.tl.runs[props.tl.runs.indexOf(props.run) + 1]
  return next ? stepName(props.tl, next.nodeKey) : null
})
const fallback = computed(() => props.run.branchTaken === 'missing' || props.run.branchTaken === 'default')
</script>

<template>
  <ol class="branches">
    <li v-for="b in ev.branches" :key="b.key" :class="{ taken: b.key === run.branchTaken }">
      <div class="bhead">
        <b>{{ humanise(b.key) }}</b>
        <span v-if="b.key === run.branchTaken" class="chip chip-ink">Taken<template v-if="dest"> → {{ dest }}</template></span>
      </div>
      <ul>
        <li v-for="(e, i) in b.trace" :key="i">
          <span>{{ traceText(tl, e) }}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <b v-if="e.missing" class="miss"><Icon name="alert" :size="13" />missing</b>
          <b v-else :class="e.result ? 'yes' : 'no'">{{ e.result ? 'yes' : 'no' }}</b>
        </li>
      </ul>
    </li>
    <li v-if="fallback" class="taken">
      <div class="bhead">
        <b>{{ run.branchTaken === 'missing' ? 'Missing data' : 'Otherwise' }}</b>
        <span class="chip chip-ink">Taken<template v-if="dest"> → {{ dest }}</template></span>
      </div>
      <p class="muted">{{ run.branchTaken === 'missing' ? 'Some data the rules need wasn’t there, so the flow didn’t decide on its own.' : 'No rule above matched.' }}</p>
    </li>
  </ol>
</template>

<style scoped>
.branches { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-width: 720px; }
.branches > li { padding: 10px 12px; border-radius: 12px; background: var(--sunk); }
.branches > li.taken { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--ink); }
.bhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
ul li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; color: var(--ink-2); }
.arrow { color: var(--ink-3); }
.yes { color: var(--ink); }
.no { color: var(--ink-2); font-weight: 500; }
.miss { color: var(--warn); display: inline-flex; gap: 4px; align-items: center; align-self: center; }
p { font-size: var(--t-sm); }
</style>
