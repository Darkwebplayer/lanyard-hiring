<script setup lang="ts">
import { humanise } from './Trace.vue'

// AI review scores: overall in ink, criteria quieter, each value written at the end of its bar.
const props = defineProps<{ output: Record<string, unknown> }>()
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
    <div v-for="r in rows" :key="r.key" class="row" :class="{ overall: r.main }">
      <span class="lbl">{{ r.label }}</span>
      <span class="track" role="img" :aria-label="`${r.label}: ${Math.round(r.v)} out of 100`">
        <span class="fill" :style="{ width: width(r.v) }" /><span class="val">{{ Math.round(r.v) }}</span>
      </span>
    </div>
    <blockquote v-if="typeof output.summary === 'string' && output.summary">“{{ output.summary }}”</blockquote>
  </div>
</template>

<style scoped>
.scores { display: grid; gap: 6px; max-width: 620px; }
.row { display: grid; grid-template-columns: minmax(90px, 9rem) minmax(0, 1fr); gap: 12px; align-items: center; font-size: var(--t-sm); }
.lbl { color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { display: flex; align-items: center; gap: 8px; height: 18px; background: linear-gradient(var(--line), var(--line)) 0 50% / calc(100% - 34px) 1px no-repeat; }
.fill { height: 8px; border-radius: 4px; background: color-mix(in oklch, var(--machine) 38%, var(--surface)); }
.val { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink-2); }
.row.overall .lbl { color: var(--ink); font-weight: 600; }
.row.overall .fill { height: 12px; border-radius: 6px; background: var(--machine); }
.row.overall .val { color: var(--ink); }
blockquote { margin: 8px 0 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--line-2); color: var(--ink-2); font-size: var(--t-sm); max-width: 70ch; }
</style>
