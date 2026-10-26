<script setup lang="ts">
import { type Timeline, humanise, reasonText, refLabel, stepName } from './Trace.vue'

// The "Why?" card: the latest decision in plain words, from the condition's evaluation, or the
// person who moved it by hand and their reason, whichever came last. Managers only (needs evaluation).
const props = defineProps<{ tl: Timeline }>()
const t = computed(() => props.tl)
const time = (iso: string | null) => (iso ? Date.parse(iso) : 0)

const cond = computed(() => t.value.runs.findLast(r => r.nodeType === 'condition' && r.evaluation && r.branchTaken))
const manual = computed(() => t.value.events.findLast(e => e.type === 'manual_move'))
const mode = computed(() => {
  const c = cond.value, m = manual.value
  if (m && (!c || time(m.createdAt) > time(c.completedAt ?? c.createdAt))) return 'manual'
  return c ? 'rule' : null
})
const closed = computed(() => t.value.application.status === 'closed')
const outcome = computed(() => {
  const o = t.value.application.outcome
  return o ? OUTCOME[o]?.text ?? humanise(o) : ''
})
const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`

const headline = computed(() => {
  if (mode.value === 'manual') {
    const e = manual.value!
    const who = e.actorName ?? 'Someone'
    if (e.data?.to?.close) return `Closed as ${e.data.to.close} by ${who}, ${fmtDate(e.createdAt)}.`
    const verb = e.data?.previous?.status === 'closed' ? 'Reopened at' : 'Moved to'
    return `${verb} ${stepName(t.value, e.data?.to?.node ?? '')} by ${who}, ${fmtDate(e.createdAt)}.`
  }
  const r = cond.value!
  const ev = r.evaluation!
  const at = stepName(t.value, r.nodeKey)
  const next = t.value.runs[t.value.runs.indexOf(r) + 1]
  const dest = next ? stepName(t.value, next.nodeKey) : null
  if (r.branchTaken === 'missing') {
    const names = list(ev.missing.map(m => refLabel(t.value, m, true)))
    return `${at} couldn’t decide: ${names} ${ev.missing.length === 1 ? 'was' : 'were'} missing, so it went to ${dest ?? 'a person'}.`
  }
  const lead = closed.value ? `${outcome.value} at ${at}` : dest ? `${at} sent this to ${dest}` : `${at} chose ${humanise(r.branchTaken!)}`
  if (r.branchTaken === 'default') return `${lead}: no rule matched, so it took the default path.`
  const held = ev.branches.find(b => b.key === r.branchTaken)?.trace.filter(e => e.result) ?? []
  return `${lead}: ${list(held.map(e => reasonText(t.value, e)))}.`
})

// The AI review behind the decision, when a rule read one of its scores.
const ai = computed(() => {
  if (mode.value !== 'rule') return null
  const refs = cond.value!.evaluation!.branches.flatMap(b => b.trace.map(e => e.ref))
  const keys = new Set(refs.filter(x => x.startsWith('nodes.')).map(x => x.split('.')[1]))
  return t.value.runs.findLast(r => r.nodeType === 'ai_review' && keys.has(r.nodeKey) && r.output) ?? null
})
</script>

<template>
  <section v-if="mode" class="card why" :data-slot="mode === 'manual' ? 'accent' : cond?.branchTaken === 'missing' ? 'warn' : 'ink'" aria-labelledby="why-h">
    <h2 id="why-h" class="eyebrow">Score rationale</h2>
    <p class="headline">{{ headline }}</p>

    <template v-if="mode === 'manual'">
      <blockquote v-if="manual!.data?.reason" class="reason">“{{ manual!.data.reason }}”</blockquote>
    </template>
    <template v-else>
      <div v-if="ai" class="block">
        <h3 class="sub">{{ stepName(tl, ai.nodeKey) }}</h3>
        <CandidateScores :output="ai.output!" />
      </div>
      <div class="block">
        <h3 class="sub">How {{ stepName(tl, cond!.nodeKey) }} decided</h3>
        <CandidateTrace :tl="tl" :run="cond!" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.why { padding: 28px 24px 22px; display: grid; align-content: start; gap: 14px; }
.headline { font-size: var(--t-xl); font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; max-width: 46ch; }
.reason { margin: 0; padding: 2px 0 2px 14px; border-left: 2px solid var(--accent-line); color: var(--ink); max-width: 70ch; }
.block { display: grid; gap: 8px; padding-top: 14px; border-top: 1px solid var(--line); }
.sub { font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
</style>
