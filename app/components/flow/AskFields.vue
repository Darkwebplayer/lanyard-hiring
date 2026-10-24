<script setup lang="ts">
import type { FieldType, FormField } from '~~/shared/workflow/types'
import { slug, uniqueKey } from '~/lib/flow'

// Stage.ask: questions the move dialog asks when someone is moved into the stage by hand.
// No files (a move has nowhere to upload to) and no lists, so it stays a few plain questions.
const props = defineProps<{ stageName: string, readOnly: boolean }>()
const fields = defineModel<FormField[]>({ required: true })

const TYPES: { value: FieldType, label: string }[] = [
  { value: 'string', label: 'Short text' },
  { value: 'text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'enum', label: 'Choice' },
  { value: 'date', label: 'Date' },
]
const MAX = 10

// the key follows the question, unique within the stage; the schema needs a label, so an empty one keeps the last
function setLabel(f: FormField, raw: string) {
  const v = raw.trim()
  if (!v) return
  f.label = v
  f.key = uniqueKey(slug(v, 'question'), fields.value.filter(x => x !== f).map(x => x.key))
}
function setType(f: FormField, t: FieldType) {
  f.type = t
  if (t === 'enum') f.options = f.options?.length ? f.options : ['Yes', 'No']
  else delete f.options
}
const setOptions = (f: FormField, raw: string) => {
  const list = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))]
  if (list.length) f.options = list
}
const list = ref<HTMLElement>()
async function add() {
  const n = fields.value.length + 1
  fields.value = [...fields.value, { key: uniqueKey(`question_${n}`, fields.value.map(x => x.key)), label: `Question ${n}`, type: 'string', required: false }]
  await nextTick()
  const inputs = list.value?.querySelectorAll<HTMLInputElement>('.q-label')
  inputs?.[inputs.length - 1]?.select()
}
const remove = (i: number) => (fields.value = fields.value.filter((_, j) => j !== i))
</script>

<template>
  <div class="ask">
    <p class="hint">A reason is always asked when someone skips ahead or goes back.</p>
    <ol v-if="fields.length" ref="list" class="qs">
      <li v-for="(f, i) in fields" :key="i" class="q">
        <input
          class="q-label" :value="f.label" maxlength="200" :aria-label="`Question ${i + 1} for ${props.stageName}`" :disabled="readOnly"
          @change="setLabel(f, ($event.target as HTMLInputElement).value); ($event.target as HTMLInputElement).value = f.label"
        >
        <select :value="f.type" :aria-label="`Answer type for ${f.label}`" :disabled="readOnly" @change="setType(f, ($event.target as HTMLSelectElement).value as FieldType)">
          <option v-for="t in TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
        <label class="check req"><input v-model="f.required" type="checkbox" :disabled="readOnly">Required</label>
        <button v-if="!readOnly" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${f.label}`" title="Remove question" @click="remove(i)"><Icon name="x" /></button>
        <input
          v-if="f.type === 'enum'" class="opts" :value="f.options?.join(', ')" :aria-label="`Choices for ${f.label}`" placeholder="Separate with commas" :disabled="readOnly"
          @change="setOptions(f, ($event.target as HTMLInputElement).value)"
        >
      </li>
    </ol>
    <button v-if="!readOnly && fields.length < MAX" type="button" class="btn btn-quiet btn-sm add" @click="add"><Icon name="plus" />Add a question</button>
  </div>
</template>

<style scoped>
.ask { display: grid; gap: 8px; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }
.qs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.q { display: grid; grid-template-columns: minmax(0, 1fr) 9.5rem auto auto; gap: 6px 8px; align-items: center; padding: 6px; border-radius: var(--r-field); background: var(--surface); }
.q > input, .q > select { min-height: var(--h-sm); }
.opts { grid-column: 1 / -1; }
.req { white-space: nowrap; font-size: var(--t-sm); }
.add { justify-self: start; margin-left: -8px; }
</style>
