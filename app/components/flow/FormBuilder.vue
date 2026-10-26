<script setup lang="ts">
import { validateVersion } from '~~/shared/workflow/graph'
import type { FieldType, FormField, Issue } from '~~/shared/workflow/types'
import type { FlowSource } from '~/composables/useFlowSource'

// The application form editor: a job's Form tab, or a flow preset's.
const props = defineProps<{ source: FlowSource }>()
const toast = useToast()
const readOnly = computed(() => props.source.readOnly.value)
const lockVersion = computed(() => props.source.lockVersion.value)
const isJob = props.source.kind === 'job'

const TYPES: { value: FieldType, label: string }[] = [
  { value: 'string', label: 'Short text' },
  { value: 'text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'enum', label: 'Choice' },
  { value: 'date', label: 'Date' },
  { value: 'file', label: 'File (PDF or Word)' },
  { value: 'list', label: 'List' },
]
const CORE = [
  { label: 'First name', required: true },
  { label: 'Last name', required: true },
  { label: 'Email', required: true },
  { label: 'Phone', required: false },
]

interface Row {
  uid: number, key: string, label: string, type: FieldType, required: boolean
  min: number | '', max: number | '', optionsText: string, protected: boolean, keyTouched: boolean
}
let seq = 0
const toRow = (f: FormField): Row => ({
  uid: ++seq, key: f.key, label: f.label, type: f.type, required: f.required, min: f.min ?? '', max: f.max ?? '',
  optionsText: (f.options ?? []).join('\n'), protected: !!f.protected, keyTouched: true,
})
const hasRange = (t: FieldType) => t === 'number' || t === 'string' || t === 'text' || t === 'list'
function toField(r: Row): FormField {
  const f: FormField = { key: r.key, label: r.label.trim(), type: r.type, required: r.required }
  if (hasRange(r.type) && r.min !== '') f.min = r.min
  if (hasRange(r.type) && r.max !== '') f.max = r.max
  if (r.type === 'enum') f.options = r.optionsText.split('\n').map(s => s.trim()).filter(Boolean)
  if (r.protected) f.protected = true
  return f
}

const rows = ref<Row[] | null>(null)
const baseline = ref('')
function reset() {
  if (!props.source.form.value) return // still loading: rows stay null, the skeleton shows
  rows.value = props.source.form.value.map(toRow)
  baseline.value = JSON.stringify(rows.value.map(toField))
}
// every save replaces both halves, so either changing means a new saved version to pick up
watch([props.source.form, props.source.workflow], () => { if (!rows.value || !dirty.value) reset() }, { immediate: true })

const form = computed(() => rows.value?.map(toField) ?? [])
const dirty = computed(() => !!rows.value && JSON.stringify(form.value) !== baseline.value)
onBeforeRouteLeave(() => !dirty.value || confirm('Leave without saving the form?'))

// Keys of fields people have already applied with can't change: renaming one counts as removing it.
const locked = (r: Row) => props.source.lockedFields.value.get(r.key) === r.type

const slug = (s: string) => {
  const k = s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return /^[a-z]/.test(k) ? k : k ? `f_${k}`.slice(0, 40) : ''
}
function onLabel(r: Row) {
  if (!r.keyTouched && !locked(r)) r.key = slug(r.label)
}

function add() {
  rows.value!.push({ uid: ++seq, key: '', label: '', type: 'string', required: false, min: '', max: '', optionsText: '', protected: false, keyTouched: false })
  nextTick(() => document.querySelector<HTMLInputElement>(`#f-label-${seq}`)?.focus())
}
function move(i: number, by: -1 | 1) {
  const list = rows.value!
  const [r] = list.splice(i, 1)
  list.splice(i + by, 0, r!)
  // keep focus on the button that was pressed, now in the row's new place
  nextTick(() => {
    const btn = (dir: string) => document.querySelector<HTMLButtonElement>(`#f-${dir}-${r!.uid}`)
    const same = btn(by < 0 ? 'up' : 'down')
    ;(same && !same.disabled ? same : btn(by < 0 ? 'down' : 'up'))?.focus()
  })
}
function remove(i: number) {
  const list = rows.value!
  const [r] = list.splice(i, 1)
  toast.show(`Removed ‘${r!.label || 'Untitled field'}’`, { label: 'Undo', run: () => list.splice(Math.min(i, list.length), 0, r!) })
}

// Problems per field, from the same check publish runs.
const workflow = computed(() => props.source.workflow.value ?? { nodes: [], edges: [] })
const issues = computed(() => validateVersion(form.value, workflow.value))
function fieldIssues(r: Row, i: number): string[] {
  const out: string[] = []
  for (const is of issues.value) {
    const m = is.message.match(/^form\.(\d+)\.(\w+)/)
    if (is.code === 'invalid_form' && m && Number(m[1]) === i) {
      out.push(m[2] === 'key' ? 'Key: lowercase letters, numbers and _, starting with a letter.'
        : m[2] === 'label' ? 'Give the field a label.'
          : m[2] === 'options' ? 'Options can’t be blank.' : is.message.replace(/^form\.\d+\./, ''))
    }
    else if (is.message.includes(`"${r.key}"`)) {
      if (is.code === 'duplicate_field') out.push('Another field already uses this key.')
      else if (is.code === 'enum_without_options') out.push('Add at least one option.')
      else if (is.code === 'min_gt_max') out.push('Min is larger than max.')
    }
  }
  return [...new Set(out)]
}
// Flow problems this form change causes (e.g. removing the CV field the CV step reads).
const baselineFlowIssues = computed(() => new Set(validateVersion(JSON.parse(baseline.value || '[]'), workflow.value).filter(i => i.node).map(i => i.message)))
const flowIssues = computed<Issue[]>(() => issues.value.filter(i => i.node && !baselineFlowIssues.value.has(i.message)))

const saving = ref(false)
const saved = ref(false)
const saveError = ref<string | null>(null)
async function save() {
  saving.value = true
  saveError.value = null
  try {
    await props.source.save({ form: form.value })
    baseline.value = JSON.stringify(form.value)
    saved.value = true
    setTimeout(() => (saved.value = false), 2500)
  }
  catch (e) { saveError.value = toApiError(e).message }
  finally { saving.value = false }
}
watch(form, () => { saved.value = false })

const minLabel = (t: FieldType) => t === 'number' ? 'Lowest value' : t === 'list' ? 'Fewest items' : 'Shortest (characters)'
const maxLabel = (t: FieldType) => t === 'number' ? 'Highest value' : t === 'list' ? 'Most items' : 'Longest (characters)'
</script>

<template>
  <div v-if="!rows" class="layout" aria-busy="true">
    <div class="panel sk"><span v-for="i in 4" :key="i" class="skeleton" /></div>
    <div class="panel sk"><span v-for="i in 3" :key="i" class="skeleton" /></div>
  </div>

  <div v-else class="layout">
    <form class="editor" @submit.prevent="save">
      <section class="panel core" aria-labelledby="core-h">
        <h2 id="core-h" class="eyebrow">Always asked</h2>
        <ul>
          <li v-for="c in CORE" :key="c.label">
            <Icon name="lock" :size="14" /><span>{{ c.label }}</span><span class="faint">{{ c.required ? 'Required' : 'Optional' }}</span>
          </li>
        </ul>
      </section>

      <fieldset :disabled="readOnly" class="fields">
        <legend class="sr-only">Your questions</legend>
        <p v-if="!readOnly && rows.some(locked)" class="lock-note"><Icon name="lock" :size="14" />Locked fields are in v{{ lockVersion }}. Candidates have answered them, so their key and type stay. To ask something different, add a new field.</p>
        <p v-if="!rows.length" class="panel none">No questions of your own yet. Add one to ask for a CV, a portfolio or anything else.</p>

        <article v-for="(r, i) in rows" :key="r.uid" class="panel row" :aria-label="r.label || 'New field'">
          <div class="row-head">
            <span class="idx">{{ i + 1 }}</span>
            <div class="field grow">
              <label :for="`f-label-${r.uid}`" class="sr-only">Label</label>
              <input :id="`f-label-${r.uid}`" v-model="r.label" class="label-input" placeholder="Question, e.g. Portfolio link" maxlength="200" @input="onLabel(r)">
            </div>
            <div class="row-actions">
              <button :id="`f-up-${r.uid}`" type="button" class="btn btn-icon btn-sm btn-quiet" :disabled="i === 0" :aria-label="`Move ${r.label || 'field'} up`" @click="move(i, -1)"><Icon name="arrow-up" /></button>
              <button :id="`f-down-${r.uid}`" type="button" class="btn btn-icon btn-sm btn-quiet" :disabled="i === rows.length - 1" :aria-label="`Move ${r.label || 'field'} down`" @click="move(i, 1)"><Icon name="arrow-down" /></button>
              <button type="button" class="btn btn-icon btn-sm btn-quiet" :aria-label="`Remove ${r.label || 'field'}`" @click="remove(i)"><Icon name="trash" /></button>
            </div>
          </div>

          <div class="grid3">
            <div class="field">
              <label :for="`f-key-${r.uid}`">Key</label>
              <div class="key-wrap">
                <input :id="`f-key-${r.uid}`" v-model="r.key" class="mono" :readonly="locked(r)" maxlength="40" placeholder="e.g. portfolio_link" spellcheck="false" autocomplete="off" @input="r.keyTouched = true">
                <Icon v-if="locked(r)" name="lock" :size="14" class="key-lock" /><span v-if="locked(r)" class="sr-only">Locked: in the published version</span>
              </div>
            </div>
            <div class="field">
              <label :for="`f-type-${r.uid}`">Type</label>
              <select :id="`f-type-${r.uid}`" v-model="r.type" :disabled="locked(r)">
                <option v-for="t in TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </div>
            <label class="check req"><input v-model="r.required" type="checkbox">Required</label>
          </div>

          <div v-if="hasRange(r.type)" class="grid2">
            <div class="field">
              <label :for="`f-min-${r.uid}`">{{ minLabel(r.type) }}</label>
              <input :id="`f-min-${r.uid}`" v-model.number="r.min" type="number" :min="r.type === 'number' ? undefined : 0" placeholder="No limit">
            </div>
            <div class="field">
              <label :for="`f-max-${r.uid}`">{{ maxLabel(r.type) }}</label>
              <input :id="`f-max-${r.uid}`" v-model.number="r.max" type="number" :min="r.type === 'number' ? undefined : 0" placeholder="No limit">
            </div>
          </div>

          <div v-if="r.type === 'enum'" class="field">
            <label :for="`f-opt-${r.uid}`">Options</label>
            <textarea :id="`f-opt-${r.uid}`" v-model="r.optionsText" rows="3" placeholder="One per line" />
          </div>

          <label class="check"><input v-model="r.protected" type="checkbox"><span><b>Protected</b> <span class="muted">Hidden from the AI and from interviewers, e.g. date of birth.</span></span></label>

          <ul v-if="fieldIssues(r, i).length" class="issues" role="alert">
            <li v-for="m in fieldIssues(r, i)" :key="m" class="error"><Icon name="alert" :size="14" />{{ m }}</li>
          </ul>
        </article>

        <button type="button" class="btn add" @click="add"><Icon name="plus" />Add field</button>
      </fieldset>

      <section v-if="flowIssues.length" class="panel flow-issues" role="alert">
        <h2 class="eyebrow">This breaks the workflow</h2>
        <ul>
          <li v-for="is in flowIssues" :key="is.message">
            <NuxtLink :to="source.flowHref(is.node)"><code>{{ is.node }}</code></NuxtLink> {{ is.message }}
          </li>
        </ul>
      </section>

      <div v-if="!readOnly" class="foot">
        <p v-if="saveError" class="form-error" role="alert"><Icon name="alert" />{{ saveError }}</p>
        <span class="status" aria-live="polite">
          <template v-if="saved"><Icon name="check" :size="14" />Saved</template>
          <template v-else-if="lockVersion != null">Saving makes a draft. v{{ lockVersion }} stays live until you publish.</template>
        </span>
        <button class="btn btn-dark" :disabled="!dirty || saving" :aria-busy="saving"><span v-if="saving" class="spinner" />{{ isJob ? 'Save draft' : 'Save' }}</button>
      </div>
    </form>

    <aside class="preview" aria-labelledby="pv-h">
      <h2 id="pv-h" class="eyebrow">What candidates see</h2>
      <div class="card sheet" inert>
        <label v-for="c in CORE" :key="c.label" class="field">
          <span class="label">{{ c.label }}<span v-if="!c.required" class="opt"> (optional)</span></span>
          <input readonly tabindex="-1">
        </label>
        <div v-for="f in form" :key="f.key + f.label" class="field">
          <template v-if="f.type === 'boolean'">
            <label class="check"><input type="checkbox" tabindex="-1">{{ f.label || 'Untitled question' }}<span v-if="!f.required" class="opt"> (optional)</span></label>
          </template>
          <template v-else>
            <span class="label">{{ f.label || 'Untitled question' }}<span v-if="!f.required" class="opt"> (optional)</span></span>
            <textarea v-if="f.type === 'text'" :aria-label="f.label" rows="2" readonly tabindex="-1" />
            <select v-else-if="f.type === 'enum'" :aria-label="f.label" tabindex="-1"><option>{{ f.options?.[0] ?? 'Choose…' }}</option></select>
            <span v-else-if="f.type === 'file'" class="drop"><b>Choose a file</b> or drop it here</span>
            <input v-else :aria-label="f.label" :type="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'" readonly tabindex="-1">
            <span v-if="f.type === 'list'" class="hint">Add one item at a time.</span>
            <span v-if="f.type === 'file'" class="hint">PDF or Word, up to 10 MB.</span>
          </template>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 340px); gap: 24px; align-items: start; }
.editor { display: grid; gap: 16px; min-width: 0; container-type: inline-size; }
.core { padding: 16px 20px; }
.core ul { list-style: none; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px 16px; }
.core li { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.core li svg { color: var(--ink-3); }
.core li .faint { font-size: var(--t-sm); font-weight: 400; }
.fields { display: grid; gap: 12px; }
.none { padding: 20px; color: var(--ink-2); }
.row { padding: 14px 16px 16px; display: grid; gap: 14px; }
.row-head { display: flex; align-items: center; gap: 10px; }
.idx { width: 24px; flex: none; text-align: center; font-weight: 600; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.grow { flex: 1; }
.label-input { font-weight: 600; }
.row-actions { display: flex; gap: 2px; flex: none; }
.grid3 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px; align-items: end; padding-left: 34px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-left: 34px; }
.row > .field, .row > .check, .issues { margin-left: 34px; }
.req { min-height: var(--h-md); align-items: center; }
.req input { margin-top: 0; }
@container (max-width: 600px) {
  .grid3 { grid-template-columns: 1fr 1fr; }
  .req { grid-column: 1 / -1; min-height: 0; }
}
.key-wrap { position: relative; }
.key-wrap input[readonly] { background: var(--sunk); color: var(--ink-2); padding-right: 32px; }
.key-lock { position: absolute; right: 12px; top: 50%; translate: 0 -50%; color: var(--ink-3); }
.lock-note { display: flex; gap: 8px; align-items: baseline; font-size: var(--t-sm); color: var(--ink-2); }
.lock-note svg { flex: none; translate: 0 2px; }
.check b { font-weight: 600; }
.issues { list-style: none; padding: 0; display: grid; gap: 4px; margin-top: 0; margin-bottom: 0; }
.add { justify-self: start; }
fieldset:disabled .add, fieldset:disabled .row-actions { display: none; }
.flow-issues { padding: 16px 20px; border-color: color-mix(in oklch, var(--warn) 35%, var(--line)); }
.flow-issues ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; color: var(--ink-2); }
.foot { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 12px 0; background: var(--bg); flex-wrap: wrap; z-index: 1; }
.foot .form-error { margin-right: auto; }
.status { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); font-size: var(--t-sm); font-weight: 500; }
.preview { position: sticky; top: 20px; display: grid; gap: 10px; }
.sheet { padding: 20px; display: grid; gap: 14px; max-height: calc(100dvh - 80px); overflow: auto; }
.sheet .label { font-weight: 600; font-size: var(--t-sm); }
.opt { font-weight: 400; color: var(--ink-3); }
.sheet input[readonly], .sheet textarea, .sheet select { min-height: 34px; }
.sk { padding: 20px; display: grid; gap: 14px; }
.sk .skeleton { height: 64px; }
.drop { display: block; padding: 14px 16px; border: 1.5px dashed var(--line-2); border-radius: var(--r-field); color: var(--ink-2); font-size: var(--t-sm); }
.drop b { color: var(--ink); }
</style>
