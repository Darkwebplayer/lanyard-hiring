<script setup lang="ts">
import type { Field, Graph } from '~~/shared/workflow/types'
import { groupFields } from '~/lib/flow'

// A text field that takes {{field}} references, with an "Insert field" menu of what this step can read.
const props = defineProps<{ label: string, fields: Field[], graph: Graph, multiline?: boolean, hideProtected?: boolean, hint?: string }>()
const model = defineModel<string>({ default: '' })
const id = useId()
const el = ref<HTMLInputElement | HTMLTextAreaElement>()
const menu = ref<HTMLElement>()
const q = ref('')

const groups = computed(() => {
  const s = q.value.trim().toLowerCase()
  return groupFields(props.fields.filter(f => f.type !== 'file'), props.graph)
    .map(g => ({ ...g, fields: g.fields.filter(f => !s || `${g.label} ${f.label} ${f.field.path}`.toLowerCase().includes(s)) }))
    .filter(g => g.fields.length)
})

function insert(path: string) {
  const t = el.value!
  const at = t.selectionStart ?? model.value.length
  const end = t.selectionEnd ?? at
  const tag = `{{${path}}}`
  model.value = model.value.slice(0, at) + tag + model.value.slice(end)
  menu.value?.hidePopover()
  nextTick(() => { t.focus(); t.setSelectionRange(at + tag.length, at + tag.length) })
}
</script>

<template>
  <div class="field tpl">
    <div class="tpl-head">
      <label :for="id">{{ label }}</label>
      <button type="button" class="btn btn-quiet btn-sm" :popovertarget="`${id}-menu`" :style="{ anchorName: `--${id}` }">
        <Icon name="braces" />Insert field
      </button>
    </div>
    <textarea v-if="multiline" :id="id" ref="el" v-model="model" rows="5" />
    <input v-else :id="id" ref="el" v-model="model">
    <p v-if="hint" class="hint">{{ hint }}</p>
    <div :id="`${id}-menu`" ref="menu" popover class="menu ins-menu" :style="{ positionAnchor: `--${id}` }" @toggle="q = ''">
      <input v-model="q" type="search" placeholder="Find a field" aria-label="Find a field">
      <p v-if="!groups.length" class="faint none">No fields match.</p>
      <div v-for="g in groups" :key="g.label" class="grp">
        <div class="eyebrow">{{ g.label }}</div>
        <button
          v-for="f in g.fields" :key="f.field.path" type="button"
          :disabled="hideProtected && f.field.protected"
          @click="insert(f.field.path)"
        >
          <span class="lbl">{{ f.label }}<small v-if="hideProtected && f.field.protected">Interviewers can’t see protected answers</small></span>
          <code>{{ f.field.path }}</code>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tpl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tpl-head label { font-weight: 600; font-size: var(--t-sm); }
.tpl-head .btn { margin-right: -8px; color: var(--accent-ink); }
input, textarea { font-variant-ligatures: none; }
.ins-menu {
  inset: auto; position-area: block-end span-inline-start; margin-top: 4px;
  width: 340px; max-height: min(380px, 60dvh); overflow-y: auto; padding: 8px;
}
.ins-menu input { min-height: var(--h-sm); margin-bottom: 4px; }
.grp { padding-top: 8px; }
.grp .eyebrow { padding: 0 10px 4px; }
.ins-menu button { justify-content: space-between; align-items: baseline; gap: 12px; padding: 6px 10px; }
.ins-menu button:disabled { cursor: not-allowed; color: var(--ink-3); background: none; }
.lbl { display: grid; min-width: 0; }
.lbl small { font-size: var(--t-xs); color: var(--ink-2); font-weight: 500; }
code { font-size: 11px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
.none { padding: 8px 10px; font-size: var(--t-sm); }
</style>
