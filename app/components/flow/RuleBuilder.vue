<script setup lang="ts">
import { OPS_BY_TYPE, VALUELESS, type Comparison, type Op, type Rule } from '~~/shared/workflow/rules'
import type { Field, FieldType, Graph } from '~~/shared/workflow/types'
import { groupFields, isComparison, opWords } from '~/lib/flow'

// One branch's rule: a comparison, or "All of / Any of" a list of comparisons. Anything deeper is shown, not edited.
const props = defineProps<{ fields: Field[], graph: Graph, readOnly?: boolean }>()
const rule = defineModel<Rule>({ required: true })

const byPath = computed(() => new Map(props.fields.map(f => [f.path, f])))
const groups = computed(() => groupFields(props.fields, props.graph))
const { show: showHelp } = useHelp()

const mode = computed<'one' | 'all' | 'any' | 'deep'>(() => {
  const r = rule.value
  if (isComparison(r)) return 'one'
  if ('all' in r && r.all.every(isComparison)) return 'all'
  if ('any' in r && r.any.every(isComparison)) return 'any'
  return 'deep'
})
const items = computed<Comparison[]>(() => {
  const r = rule.value as any
  return mode.value === 'one' ? [r] : mode.value === 'all' ? r.all : mode.value === 'any' ? r.any : []
})

function setItems(list: Comparison[], join: 'all' | 'any' = mode.value === 'any' ? 'any' : 'all') {
  rule.value = list.length === 1 ? list[0]! : join === 'any' ? { any: list } : { all: list }
}
const patch = (i: number, c: Comparison) => setItems(items.value.map((x, j) => j === i ? c : x))

const typeOf = (c: Comparison): FieldType | undefined => byPath.value.get(c.ref)?.type
const opsFor = (c: Comparison) => {
  const t = typeOf(c)
  return t ? OPS_BY_TYPE[t] : [c.op]
}

// A sensible first operator per type, so a fresh row reads like a sentence.
const FIRST: Partial<Record<FieldType, Op>> = { number: 'gte', boolean: 'is_true', date: 'gt', list: 'contains', text: 'contains', file: 'exists' }
function setField(i: number, path: string) {
  const old = items.value[i]!
  const f = byPath.value.get(path)!
  const keepOp = typeOf(old) === f.type && OPS_BY_TYPE[f.type].includes(old.op)
  const op = keepOp ? old.op : FIRST[f.type] ?? 'eq'
  patch(i, keepOp ? { ...old, ref: path } : { ref: path, op })
}
function setOp(i: number, op: Op) {
  const c = items.value[i]!
  const listy = (o: Op) => o === 'in' || o === 'nin' || o === 'between'
  const keep = !VALUELESS.includes(op) && listy(op) === listy(c.op)
  const next: Comparison = { ref: c.ref, op }
  if (keep && c.value !== undefined) next.value = c.value
  patch(i, next)
}

const isNum = (c: Comparison) => typeOf(c) === 'number'
function setValue(i: number, raw: string) {
  const c = items.value[i]!
  const v = isNum(c) ? (raw === '' ? undefined : Number(raw)) : raw === '' ? undefined : raw
  const next: Comparison = { ref: c.ref, op: c.op }
  if (v !== undefined) next.value = v
  patch(i, next)
}
function setPair(i: number, at: 0 | 1, raw: string) {
  const c = items.value[i]!
  const pair = Array.isArray(c.value) ? [...c.value] : [undefined, undefined]
  pair[at] = raw === '' ? undefined : isNum(c) ? Number(raw) : raw
  patch(i, { ref: c.ref, op: c.op, value: pair })
}
// "in" / "not in": comma-separated, or ticks for a choice field
function setList(i: number, raw: string) {
  const c = items.value[i]!
  const list = raw.split(',').map(s => s.trim()).filter(Boolean).map(s => isNum(c) ? Number(s) : s)
  patch(i, { ref: c.ref, op: c.op, value: list })
}
function toggleOption(i: number, opt: string, on: boolean) {
  const c = items.value[i]!
  const cur = Array.isArray(c.value) ? c.value as string[] : []
  patch(i, { ref: c.ref, op: c.op, value: on ? [...cur, opt] : cur.filter(x => x !== opt) })
}

function add() {
  const last = items.value.at(-1)
  setItems([...items.value, last ? { ref: last.ref, op: last.op } : { ref: props.fields[0]?.path ?? 'candidate.email', op: 'exists' }])
}
const remove = (i: number) => setItems(items.value.filter((_, j) => j !== i))
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const inputType = (c: Comparison) => typeOf(c) === 'number' ? 'number' : typeOf(c) === 'date' ? 'date' : 'text'
</script>

<template>
  <div class="rule">
    <template v-if="mode === 'deep'">
      <p class="hint">This rule has nested groups, which this editor can’t change. It still works as written.</p>
      <pre class="json">{{ JSON.stringify(rule, null, 2) }}</pre>
    </template>
    <template v-else>
      <label v-if="items.length > 1" class="join">
        <span class="sr-only">Match</span>
        <select :value="mode" @change="setItems(items, ($event.target as HTMLSelectElement).value as 'all' | 'any')">
          <option value="all">All of these are true</option>
          <option value="any">Any of these is true</option>
        </select>
      </label>
      <div v-for="(c, i) in items" :key="i" class="cmp">
        <div class="cmp-row">
          <select :value="c.ref" aria-label="Field" @change="setField(i, ($event.target as HTMLSelectElement).value)">
            <option v-if="!byPath.get(c.ref)" :value="c.ref">{{ c.ref }} (not available here)</option>
            <optgroup v-for="g in groups" :key="g.label" :label="g.label">
              <option v-for="f in g.fields" :key="f.field.path" :value="f.field.path">{{ f.label }}</option>
            </optgroup>
          </select>
          <button v-if="items.length > 1 && !readOnly" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove condition ${i + 1}`" @click="remove(i)">
            <Icon name="x" />
          </button>
        </div>
        <div class="cmp-row">
          <select :value="c.op" aria-label="Test" class="op" @change="setOp(i, ($event.target as HTMLSelectElement).value as Op)">
            <option v-for="op in opsFor(c)" :key="op" :value="op">{{ opWords(op, typeOf(c)) }}</option>
          </select>
          <template v-if="VALUELESS.includes(c.op)" />
          <span v-else-if="c.op === 'between'" class="pair">
            <input :type="inputType(c)" :value="str((c.value as unknown[] | undefined)?.[0])" aria-label="From" @change="setPair(i, 0, ($event.target as HTMLInputElement).value)">
            <span class="faint">–</span>
            <input :type="inputType(c)" :value="str((c.value as unknown[] | undefined)?.[1])" aria-label="To" @change="setPair(i, 1, ($event.target as HTMLInputElement).value)">
          </span>
          <fieldset v-else-if="(c.op === 'in' || c.op === 'nin') && byPath.get(c.ref)?.options" class="opts">
            <legend class="sr-only">Values</legend>
            <label v-for="o in byPath.get(c.ref)!.options" :key="o" class="check">
              <input type="checkbox" :checked="Array.isArray(c.value) && c.value.includes(o)" @change="toggleOption(i, o, ($event.target as HTMLInputElement).checked)">{{ o }}
            </label>
          </fieldset>
          <input
            v-else-if="c.op === 'in' || c.op === 'nin'" :value="Array.isArray(c.value) ? c.value.join(', ') : ''"
            placeholder="Separate with commas" aria-label="Values" @change="setList(i, ($event.target as HTMLInputElement).value)"
          >
          <select v-else-if="byPath.get(c.ref)?.options" :value="str(c.value)" aria-label="Value" @change="setValue(i, ($event.target as HTMLSelectElement).value)">
            <option value="" disabled>Choose…</option>
            <option v-for="o in byPath.get(c.ref)!.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input v-else :type="inputType(c)" :value="str(c.value)" aria-label="Value" @input="setValue(i, ($event.target as HTMLInputElement).value)">
        </div>
      </div>
      <div class="foot">
        <button v-if="!readOnly" type="button" class="btn btn-quiet btn-sm add" @click="add">
          <Icon name="plus" />Add a condition
        </button>
        <!-- the field list mixes everyday answers with step outputs such as CV text; Words says which ones matter -->
        <button type="button" class="what" aria-label="What’s this? What a rule can check" @click="showHelp('words')">What’s this?</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rule { display: grid; gap: 8px; }
.cmp { display: grid; gap: 6px; padding: 10px; border-radius: var(--r-field); background: var(--sunk); }
.cmp-row { display: flex; gap: 6px; align-items: center; min-width: 0; }
.cmp-row > select, .cmp-row > input { flex: 1; min-width: 0; }
.cmp-row .op { flex: 0 1 auto; width: auto; min-width: 9.5rem; }
.pair { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.opts { flex: 1; display: flex; flex-wrap: wrap; gap: 6px 14px; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.add { margin-left: -8px; }
.what { margin-left: auto; padding: 0; border: 0; background: none; font: 500 var(--t-xs) var(--font); color: var(--accent-ink); text-decoration: underline; text-underline-offset: 0.18em; cursor: pointer; }
.what:hover { color: var(--ink); }
.json { margin: 0; padding: 10px 12px; border-radius: var(--r-field); background: var(--sunk); font: 12px/1.5 var(--mono); overflow-x: auto; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }
</style>
