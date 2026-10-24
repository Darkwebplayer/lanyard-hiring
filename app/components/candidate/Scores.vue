<script setup lang="ts">
import { humanise } from './Trace.vue'

// AI review scores: overall in ink, criteria quieter, each value written at the end of its bar.
// nodeKey: the AI review step, so "Why?" can point Ask at it
const props = defineProps<{ output: Record<string, unknown>, nodeKey?: string }>()
const { canAsk } = useMe()
const { open, focus, lastQuestion, ask } = useAsk()
const at = computed(() => `node:${props.nodeKey}`)
const question = (r: { label: string, v: number }) => `Why ${Math.round(r.v)} on ${r.label.toLowerCase()}?`
// the row you asked about keeps an ink outline while its answer is open
const asked = (r: { label: string, v: number }) => open.value && focus.value === at.value && lastQuestion.value === question(r)
const rows = computed(() => {
  const o = props.output
  const crit = Object.entries(o).filter(([k, v]) => k !== 'overall' && typeof v === 'number') as [string, number][]
  return [
    ...(typeof o.overall === 'number' ? [{ key: 'overall', label: 'Overall', v: o.overall, main: true }] : []),
    ...crit.map(([k, v]) => ({ key: k, label: humanise(k), v, main: false })),
  ]
})
const width = (v: number) => `calc((100% - 34px) * ${Math.min(Math.max(v, 0), 100) / 100})`
</script>

<template>
  <div class="scores">
    <div v-for="r in rows" :key="r.key" class="row" :class="{ overall: r.main, asked: asked(r) }">
      <span class="lbl">{{ r.label }}</span>
      <span class="track" role="img" :aria-label="`${r.label}: ${Math.round(r.v)} out of 100`">
        <span class="fill" :style="{ width: width(r.v) }" /><span class="val">{{ Math.round(r.v) }}</span>
      </span>
      <button
        v-if="canAsk && nodeKey && !r.main" type="button" class="why" :aria-label="`Why ${Math.round(r.v)} on ${r.label}? Opens Ask`"
        @click="ask(question(r), at)"
      >Why?</button>
    </div>
    <blockquote v-if="typeof output.summary === 'string' && output.summary">“{{ output.summary }}”</blockquote>
  </div>
</template>

<style scoped>
.scores { display: grid; gap: 6px; max-width: 620px; }
.row { display: grid; grid-template-columns: minmax(90px, 9rem) minmax(0, 1fr) 48px; gap: 12px; align-items: center; min-height: 28px; padding: 0 6px; margin: 0 -6px; border-radius: 8px; font-size: var(--t-sm); }
/* Why? shows on hover and keyboard focus, and always on touch, where nothing hovers */
.why {
  justify-self: end; height: 24px; padding: 0 9px; border: 0; border-radius: var(--r-pill); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2);
  font: 600 var(--t-xs) var(--font); color: var(--ink); cursor: pointer; opacity: 0; transition: opacity var(--t-micro) var(--ease);
}
.row:hover .why, .row:focus-within .why, .row.asked .why { opacity: 1; }
@media (hover: none), (pointer: coarse) { .why { opacity: 1; } }
.why:hover { background: var(--hover); }
.why:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row.asked { background: var(--sunk); box-shadow: inset 0 0 0 1.5px var(--ink); }
.lbl { color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { display: flex; align-items: center; gap: 8px; height: 18px; background: linear-gradient(var(--line), var(--line)) 0 50% / calc(100% - 34px) 1px no-repeat; }
.fill { height: 8px; border-radius: 4px; background: color-mix(in oklch, var(--machine) 38%, var(--surface)); }
.val { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink-2); }
.row.overall .lbl { color: var(--ink); font-weight: 600; }
.row.overall .fill { height: 12px; border-radius: 6px; background: var(--machine); }
.row.overall .val { color: var(--ink); }
blockquote { margin: 8px 0 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--line-2); color: var(--ink-2); font-size: var(--t-sm); max-width: 70ch; }
</style>
