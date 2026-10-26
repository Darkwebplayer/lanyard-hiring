<script setup lang="ts">
import type { Graph } from '~~/shared/workflow/types'
import { nextMoves } from './NextMenu.vue'
import { type Timeline, stepName } from './Trace.vue'

// The candidate's own path through the version they started on: what's done, where they are, where it can go.
const props = defineProps<{ tl: Timeline, graph: Graph }>()
const heading = ref<HTMLElement>()
defineExpose({ focus: () => { heading.value?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); heading.value?.focus({ preventScroll: true }) } })

const app = computed(() => props.tl.application)
const here = computed(() => app.value.status === 'active' ? app.value.currentNodeKey : null)

const branchLabel = (nodeKey: string, key: string) => {
  if (key === 'default') return 'Otherwise'
  if (key === 'missing') return 'Missing data'
  const n = props.graph.nodes.find(x => x.key === nodeKey)
  return (n?.config as { branches?: { key: string, label?: string }[] } | null)?.branches?.find(b => b.key === key)?.label || key
}

// Decisions aren't places: their branch goes on the step before, as the reason the path turned.
const path = computed(() => {
  const rows: { id: string, name: string, note: string | null, state: 'done' | 'skipped' | 'stopped' | 'here' }[] = []
  props.tl.runs.forEach((r, i) => {
    if (r.nodeType === 'condition') {
      const prev = rows.at(-1)
      if (prev && r.branchTaken) prev.note = branchLabel(r.nodeKey, r.branchTaken)
      return
    }
    if (r.nodeType === 'end') return
    const last = i === props.tl.runs.length - 1
    const state = last && r.nodeKey === here.value ? 'here' : r.status === 'cancelled' ? 'skipped' : r.status === 'failed' ? 'stopped' : 'done'
    rows.push({ id: r.id, name: stepName(props.tl, r.nodeKey), note: null, state })
  })
  return rows
})
const next = computed(() => here.value ? nextMoves(props.tl, props.graph, here.value) : [])
</script>

<template>
  <section class="panel flow" aria-labelledby="flow-h">
    <div class="fhead">
      <h2 id="flow-h" ref="heading" class="sec" tabindex="-1">Workflow</h2>
      <span class="faint ver">v{{ tl.version }}, the version {{ tl.candidate.firstName }} started on</span>
    </div>
    <ol class="path">
      <li v-for="p in path" :key="p.id" :class="p.state">
        <span class="pdot" aria-hidden="true"><Icon v-if="p.state === 'done'" name="check" :size="12" /><Icon v-else-if="p.state === 'stopped'" name="stop" :size="12" /></span>
        <span class="pname">{{ p.name }}</span>
        <span v-if="p.state === 'here'" class="tag here-tag">Here now</span>
        <span v-else-if="p.state === 'skipped'" class="tag">Skipped</span>
        <span v-else-if="p.state === 'stopped'" class="tag">Failed</span>
        <span v-else-if="p.note" class="chip">{{ p.note }}</span>
      </li>
      <li v-if="app.status === 'closed'" class="done end">
        <span class="pdot" aria-hidden="true"><Icon name="flag" :size="12" /></span>
        <span class="pname">Closed as {{ app.outcome }}</span>
      </li>
    </ol>
    <template v-if="next.length">
      <h3 class="nh">Can go next</h3>
      <ul class="next">
        <li v-for="m in next" :key="'node' in m.to ? m.to.node : m.to.closed">
          <span v-if="m.branch" class="lbl">{{ m.branch }}</span>{{ m.name }}
        </li>
      </ul>
    </template>
    <NuxtLink :to="`/jobs/${tl.job.id}/flow`" class="full">Open the full workflow</NuxtLink>
  </section>
</template>

<style scoped>
.flow { padding: 18px; display: grid; gap: 12px; }
.fhead { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.sec { font-size: var(--t-lg); margin: 0; }
.sec:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
.ver { font-size: var(--t-xs); }
.path { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; position: relative; }
/* one rail behind the dots, the same way the Steps timeline draws it */
.path::before { content: ""; position: absolute; left: 9.5px; top: 12px; bottom: 12px; width: 1px; background: var(--line-2); }
.path li { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.pdot { position: relative; flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2), 0 0 0 3px var(--surface); color: #fff; }
.done .pdot { background: var(--ok); box-shadow: 0 0 0 3px var(--surface); }
.stopped .pdot { background: var(--bad); box-shadow: 0 0 0 3px var(--surface); }
.here { color: var(--ink); }
.here .pdot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 4px var(--surface); }
.pname { min-width: 0; overflow-wrap: anywhere; }
.skipped .pname { text-decoration: line-through; text-decoration-color: var(--ink-3); }
.tag { margin-left: auto; flex: none; font-size: var(--t-xs); color: var(--ink-3); font-weight: 500; }
.here-tag { color: var(--accent-ink); font-weight: 600; }
.chip { margin-left: auto; flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nh { font-size: var(--t-xs); font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; margin: 4px 0 0; }
.next { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
.next li { display: grid; gap: 2px; padding: 8px 10px; border-radius: var(--r-field); outline: 1.5px dashed var(--line-2); outline-offset: -1.5px; font-size: var(--t-sm); font-weight: 600; overflow-wrap: anywhere; }
.lbl { font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); }
.full { font-size: var(--t-sm); font-weight: 600; }
</style>
