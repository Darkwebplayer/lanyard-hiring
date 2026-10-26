<script setup lang="ts">
import type { GraphNode, Stage } from '~~/shared/workflow/types'
import { titleOf } from '~/lib/flow'

// Stages group steps into the pipeline board's columns. Picking one lights its steps on the canvas;
// while it is picked, clicking a step adds or removes it.
const props = defineProps<{ stages: Stage[], active: string | null, nodes: GraphNode[] }>()
const emit = defineEmits<{
  add: [], activate: [id: string | null], rename: [id: string, name: string], remove: [id: string], move: [id: string, dir: -1 | 1], drop: [id: string, key: string]
}>()
const nodeOf = (k: string) => props.nodes.find(n => n.key === k)

// a new stage opens with its name selected, ready to type over
const list = ref<HTMLElement>()
watch(() => props.stages.length, async (n, was) => {
  if (n <= was) return
  await nextTick()
  const input = list.value?.querySelector<HTMLInputElement>('.s-name')
  input?.focus()
  input?.select()
})
function rename(s: Stage, e: Event) {
  const v = (e.target as HTMLInputElement).value.trim()
  if (v && v !== s.name) emit('rename', s.id, v)
  else (e.target as HTMLInputElement).value = s.name
}
</script>

<template>
  <div class="stages">
    <p class="pal-hint">Stages are the columns of the pipeline board. They don’t change how the workflow runs.</p>
    <p v-if="!stages.length" class="none">No stages yet. Without them, the board shows one column per step.</p>
    <p v-else-if="!active" class="pal-hint">Set a step’s stage on its card, or open a stage to add several steps.</p>
    <ol ref="list" class="list">
      <li v-for="(s, i) in stages" :key="s.id" class="stage" :class="{ on: active === s.id }">
        <div class="s-top">
          <button type="button" class="s-pick" :aria-pressed="active === s.id" @click="emit('activate', active === s.id ? null : s.id)">
            <span class="s-label">{{ s.name }}</span>
            <span class="s-n">{{ plural(s.nodeKeys.length, 'step') }}</span>
          </button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Move ${s.name} up, one column left on the board`" :disabled="i === 0" @click="emit('move', s.id, -1)"><Icon name="arrow-up" :size="14" /></button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Move ${s.name} down, one column right on the board`" :disabled="i === stages.length - 1" @click="emit('move', s.id, 1)"><Icon name="arrow-down" :size="14" /></button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Delete stage ${s.name}`" title="Delete stage" @click="emit('remove', s.id)"><Icon name="trash" :size="14" /></button>
        </div>
        <div v-if="active === s.id" class="s-body">
          <input class="s-name" :value="s.name" maxlength="40" aria-label="Stage name" @change="rename(s, $event)" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()">
          <p class="pal-hint">Use the pill on each step, or click the step, to add it or take it out.</p>
          <ul v-if="s.nodeKeys.length" class="s-steps">
            <li v-for="k in s.nodeKeys" :key="k">
              <Icon :name="nodeMeta(nodeOf(k)?.type ?? '').icon" :size="14" />
              <span class="s-step">{{ nodeOf(k) ? titleOf(nodeOf(k)!) : k }}</span>
              <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Take ${nodeOf(k) ? titleOf(nodeOf(k)!) : k} out of ${s.name}`" @click="emit('drop', s.id, k)"><Icon name="x" :size="14" /></button>
            </li>
          </ul>
          <button type="button" class="btn btn-dark btn-sm done" @click="emit('activate', null)"><Icon name="check" />Done</button>
        </div>
      </li>
    </ol>
    <button type="button" class="btn btn-sm btn-quiet add" @click="emit('add')"><Icon name="plus" />New stage</button>
  </div>
</template>

<style scoped>
.stages { display: grid; gap: 10px; align-content: start; }
.pal-hint { font-size: var(--t-xs); color: var(--ink-2); padding: 0 6px; }
.none { font-size: var(--t-sm); color: var(--ink-2); padding: 8px 6px; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.stage { border-radius: 12px; background: var(--sunk); }
.stage.on { background: var(--accent-tint); box-shadow: inset 0 0 0 1px var(--accent-line); }
.s-top { display: flex; align-items: center; gap: 2px; padding: 3px; }
.s-pick {
  flex: 1; min-width: 0; display: grid; text-align: left; padding: 5px 8px; border: 0; border-radius: 9px;
  background: none; cursor: pointer; line-height: 1.3;
}
.s-pick:hover { background: var(--hover); }
.on .s-pick:hover { background: none; }
.s-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-n { font-size: var(--t-xs); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.on .s-n { color: var(--accent-ink); }
.s-name { min-height: var(--h-sm); font-weight: 600; }
.s-body { display: grid; gap: 8px; padding: 2px 8px 10px; }
.s-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.s-steps li { display: flex; align-items: center; gap: 8px; min-height: 30px; padding-left: 6px; border-radius: 8px; background: var(--surface); }
.s-steps svg { flex: none; color: var(--ink-2); }
.s-step { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); }
.done { justify-self: start; }
.add { justify-self: start; }
</style>
