<script lang="ts">
import type { InjectionKey } from 'vue'

// What the stage chip on a card can do; the editor provides it.
export const STAGE_ACTIONS: InjectionKey<{ assign: (key: string, stageId: string | null) => void, toggle: (key: string) => void }> = Symbol('stage-actions')
export type StageChip =
  | { mode: 'pick', current: string | null, options: { id: string, name: string }[] } // no stage open: which one is this step in?
  | { mode: 'toggle', name: string, in: boolean, from: string | null } // a stage is open: is this step in it, or in which other one?
</script>

<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'

export interface StepData {
  type: string, noun: string, icon: string, slot: string, title: string, summary: string, width: number
  issues: number, selected: boolean, readOnly: boolean
  stage: 'in' | 'out' | 'na' | null // a stage is picked: this step is in it, could be, or can't be (nobody waits there)
  stageChip: StageChip | null
  branches: { key: string, label: string, linked: boolean }[] | null
}
const props = defineProps<NodeProps<StepData>>()
const d = computed(() => props.data)
const id = computed(() => props.id)
const sameName = computed(() => d.value.title.toLowerCase() === d.value.noun.toLowerCase())
const stageActions = inject(STAGE_ACTIONS, null)
const at = (i: number) => `${((i + 0.5) / d.value.branches!.length) * 100}%`
</script>

<template>
  <div
    :data-ask="`node:${id}`" class="step card" :class="{ selected: d.selected, broken: d.issues > 0, [`stage-${d.stage}`]: !!d.stage }" :data-slot="d.issues ? 'bad' : d.slot"
    :style="{ width: `${d.width}px` }"
  >
    <Handle v-if="d.type !== 'application_received'" type="target" :position="Position.Top" :connectable="!d.readOnly" />
    <!-- the type word only when the name doesn't already say it ("Read CV" under "READ CV"); else the icon joins the name -->
    <div v-if="!sameName || d.issues" class="eyebrow">
      <template v-if="!sameName"><Icon :name="d.icon" :size="14" />{{ d.noun }}</template>
      <span v-if="d.issues" class="chip chip-bad count" :title="`${d.issues} problem${d.issues === 1 ? '' : 's'}`">
        <Icon name="alert" />{{ d.issues }}<span class="sr-only"> problem{{ d.issues === 1 ? '' : 's' }}</span>
      </span>
    </div>
    <div class="title"><Icon v-if="sameName" :name="d.icon" :size="14" class="title-icon" />{{ d.title }}</div>
    <div class="summary">{{ d.summary }}</div>
    <!-- nodrag/nopan and .stop: the chip is its own control, not a grab or a click on the card -->
    <div v-if="d.stageChip" class="stage-chip nodrag nopan" @click.stop @dblclick.stop>
      <label v-if="d.stageChip.mode === 'pick'" class="sc-pick" :class="{ none: !d.stageChip.current }">
        <select :value="d.stageChip.current ?? ''" :aria-label="`Stage for ${d.title}`" @change="stageActions?.assign(id, ($event.target as HTMLSelectElement).value || null)">
          <option value="">No stage</option>
          <option v-for="o in d.stageChip.options" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
        <Icon name="chevron-down" :size="12" />
      </label>
      <!-- a step sits in one stage, so joining this one from another is a move, and says from where -->
      <button
        v-else type="button" class="sc-toggle" :data-in="d.stageChip.in" @click="stageActions?.toggle(id)"
        :aria-label="d.stageChip.in ? `In ${d.stageChip.name}: take ${d.title} out` : d.stageChip.from ? `Move ${d.title} from ${d.stageChip.from} to ${d.stageChip.name}` : `Add ${d.title} to ${d.stageChip.name}`"
      >
        <Icon :name="d.stageChip.in ? 'check' : d.stageChip.from ? 'move' : 'plus'" :size="12" />
        <template v-if="d.stageChip.in">In {{ d.stageChip.name }}</template>
        <template v-else-if="d.stageChip.from">{{ d.stageChip.from }} → {{ d.stageChip.name }}</template>
        <template v-else>Add to {{ d.stageChip.name }}</template>
      </button>
    </div>
    <template v-if="d.branches">
      <template v-for="(b, i) in d.branches" :key="b.key">
        <Handle :id="b.key" type="source" :position="Position.Bottom" :connectable="!d.readOnly" :style="{ left: at(i) }" :title="b.label" />
        <span class="branch" :class="{ open: !b.linked }" :style="{ left: at(i) }">{{ b.label }}</span>
      </template>
    </template>
    <Handle v-else-if="d.type !== 'end'" type="source" :position="Position.Bottom" :connectable="!d.readOnly" />
  </div>
</template>

<style scoped>
.step { padding: 22px 16px 14px; border-radius: 16px; cursor: pointer; }
.eyebrow { display: flex; align-items: center; gap: 6px; min-height: 22px; }
.count { margin-left: auto; letter-spacing: 0; }
.title-icon { display: inline-block; vertical-align: -2px; margin-right: 6px; color: var(--ink-2); }
.title { margin-top: 4px; font-weight: 600; font-size: var(--t-md); line-height: 1.3; color: var(--ink); overflow-wrap: anywhere; }
.summary { margin-top: 2px; font-size: var(--t-sm); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent), var(--shadow-2); }
.broken { border-color: color-mix(in oklch, var(--bad) 55%, transparent); }
/* a picked stage: its steps stay lit in ink (magenta is selection), everything else steps back */
.stage-in { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), var(--shadow-2); }
/* a step that could join keeps its name and its chip at full strength: only the details step back */
.stage-out { border-color: var(--line); box-shadow: none; }
.stage-out .eyebrow, .stage-out .summary { opacity: 0.45; }
.stage-na { opacity: 0.32; }
.stage-na { cursor: not-allowed; }
.broken.selected { box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent), var(--shadow-2); }

/* the stage chip: a pill on the card's foot, one per step people wait at, only on the Stages tab */
.stage-chip { display: flex; margin-top: 10px; }
.sc-pick, .sc-toggle {
  position: relative; display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 28px; border-radius: var(--r-pill);
  font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); background: var(--sunk);
}
.sc-pick select {
  appearance: none; height: 100%; min-height: 0; width: auto; max-width: 100%; padding: 0 26px 0 10px; border: 0; border-radius: inherit;
  background: none; font: inherit; color: inherit; cursor: pointer; text-overflow: ellipsis;
}
.sc-pick select:focus-visible { box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent); }
.sc-pick svg { position: absolute; right: 9px; pointer-events: none; }
.sc-pick:hover, .sc-toggle:hover { color: var(--ink); background: var(--hover); }
/* an empty slot: dashed, so it reads as a place to put something */
.sc-pick.none, .sc-toggle[data-in="false"] { background: none; outline: 1px dashed var(--ink-3); outline-offset: -1px; }
.sc-toggle { padding: 0 10px; border: 0; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-pick.none:hover, .sc-toggle[data-in="false"]:hover { outline-style: solid; outline-color: var(--ink); background: var(--surface); }
/* in the open stage: ink, like the card's own ring */
.sc-toggle[data-in="true"] { background: var(--ink); color: #fff; }
.sc-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* branch names sit on the start of each outgoing line, under the handle they belong to */
.branch {
  position: absolute; top: calc(100% + 14px); translate: -50% 0; max-width: 96px; padding: 1px 8px; border-radius: var(--r-pill);
  font-size: var(--t-xs); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: var(--surface); color: var(--ink-2); box-shadow: 0 0 0 1px var(--line-2); pointer-events: none;
}
.branch.open { color: var(--warn); background: var(--warn-tint); box-shadow: 0 0 0 1px color-mix(in oklch, var(--warn) 40%, transparent); }
</style>
