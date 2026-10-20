<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'

export interface StepData {
  type: string, noun: string, icon: string, slot: string, title: string, summary: string, width: number
  issues: number, selected: boolean, readOnly: boolean
  branches: { key: string, label: string, linked: boolean }[] | null
}
const props = defineProps<NodeProps<StepData>>()
const d = computed(() => props.data)
const sameName = computed(() => d.value.title.toLowerCase() === d.value.noun.toLowerCase())
const at = (i: number) => `${((i + 0.5) / d.value.branches!.length) * 100}%`
</script>

<template>
  <div
    class="step card" :class="{ selected: d.selected, broken: d.issues > 0 }" :data-slot="d.issues ? 'bad' : d.slot"
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
.broken.selected { box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent), var(--shadow-2); }

/* branch names sit on the start of each outgoing line, under the handle they belong to */
.branch {
  position: absolute; top: calc(100% + 14px); translate: -50% 0; max-width: 96px; padding: 1px 8px; border-radius: var(--r-pill);
  font-size: var(--t-xs); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: var(--surface); color: var(--ink-2); box-shadow: 0 0 0 1px var(--line-2); pointer-events: none;
}
.branch.open { color: var(--warn); background: var(--warn-tint); box-shadow: 0 0 0 1px color-mix(in oklch, var(--warn) 40%, transparent); }
</style>
