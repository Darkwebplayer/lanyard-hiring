<script setup lang="ts">
import { fieldsAvailableAt } from '~~/shared/workflow/graph'
import type { HumanTaskConfig, ScorecardField } from '~~/shared/workflow/registry'
import type { ConditionConfig, Rule } from '~~/shared/workflow/rules'
import { render } from '~~/shared/workflow/template'
import { type FormField, type Graph, type GraphNode, type Issue, KEY_RE } from '~~/shared/workflow/types'
import { type Person, type Role, issueText, reaches, sampleContext, slug, titleOf, uniqueKey } from '~/lib/flow'
import RuleBuilder from './RuleBuilder.vue'
import TemplateField from './TemplateField.vue'

const props = defineProps<{
  node: GraphNode, graph: Graph, form: FormField[], roles: Role[], people: Person[] | null
  issues: Issue[], keyLocked: boolean, readOnly: boolean, formHref: string
  liveQuestions?: Set<string> // keys this step's questions have in the live flow
  job: { title: string, openings: number, requirements?: object }
  // preset: editing a library preset, not a step in a flow: no key, no connections, no delete
  preset?: boolean
}>()
const emit = defineEmits<{ rename: [key: string], connect: [branch: string | undefined, to: string], remove: [], close: [], savePreset: [] }>()

const meta = computed(() => nodeMeta(props.node.type))
const { canAsk } = useMe()
const { ask } = useAsk()
const explain = () => ask(`What does ${titleOf(props.node)} do in this workflow?`, `node:${props.node.key}`)
const refHint = computed(() => `{{nodes.${props.node.key}.…}}`)
const c = computed(() => props.node.config as any)
const fields = computed(() => fieldsAvailableAt(props.graph, props.node.key, props.form))
const connected = computed(() => fields.value.length > 0)

// ---------- name and key ----------
const keyDraft = ref(props.node.key)
watch(() => props.node.key, k => (keyDraft.value = k))
const keyError = computed(() => {
  const k = keyDraft.value
  if (k === props.node.key) return ''
  if (!KEY_RE.test(k)) return 'Use lowercase letters, numbers and _, starting with a letter.'
  if (props.graph.nodes.some(n => n.key === k)) return 'Another step already uses this key.'
  return ''
})
function commitKey() {
  if (keyDraft.value !== props.node.key && !keyError.value) emit('rename', keyDraft.value)
}
// shows the name the step goes by now (its own label, else the one made from its key), so it never reads as empty
const derivedName = computed(() => titleOf({ ...props.node, label: undefined }))
const label = computed({
  get: () => props.node.label ?? derivedName.value,
  set: (v: string) => { props.node.label = v.trim() && v.trim() !== derivedName.value ? v : undefined },
})

// ---------- where each exit goes ----------
const targets = computed(() => props.graph.nodes
  .filter(n => n.key !== props.node.key && n.type !== 'application_received')
  .map(n => ({ key: n.key, title: titleOf(n), loops: reaches(props.graph, n.key, props.node.key) })))
const goesTo = (branch?: string) => props.graph.edges.find(e => e.from === props.node.key && (e.branch ?? undefined) === branch)?.to ?? ''

// ---------- condition ----------
const cond = computed(() => c.value as ConditionConfig)
function moveBranch(i: number, by: -1 | 1) {
  const b = cond.value.branches
  ;[b[i], b[i + by]] = [b[i + by]!, b[i]!]
}
function addBranch() {
  const keys = cond.value.branches.map(b => b.key)
  const key = uniqueKey(`branch_${keys.length + 1}`, [...keys, 'default', 'missing'])
  const prev = cond.value.branches.at(-1)?.rule
  cond.value.branches.push({ key, label: `Branch ${keys.length + 1}`, rule: prev ? structuredClone(toRaw(prev)) : { ref: fields.value[0]?.path ?? 'candidate.email', op: 'exists' } })
}
function dropBranch(i: number) {
  const [b] = cond.value.branches.splice(i, 1)
  props.graph.edges = props.graph.edges.filter(e => !(e.from === props.node.key && e.branch === b!.key))
}
const branchKeyError = (key: string) => !KEY_RE.test(key) ? 'Lowercase letters, numbers and _' : ['default', 'missing'].includes(key) || cond.value.branches.filter(b => b.key === key).length > 1 ? 'Already used' : ''
function renameBranch(i: number, next: string) {
  const b = cond.value.branches[i]!
  const old = b.key
  b.key = next
  if (branchKeyError(next)) return
  for (const e of props.graph.edges) if (e.from === props.node.key && e.branch === old) e.branch = next
}
// the key follows the name until edited by hand, and the links follow the key
function relabelBranch(i: number, next: string) {
  const b = cond.value.branches[i]!
  const follows = b.key === slug(b.label, 'branch')
  b.label = next
  const k = slug(next, 'branch')
  if (follows && k !== b.key && !['default', 'missing'].includes(k) && !cond.value.branches.some(x => x.key === k)) renameBranch(i, k)
}
function setOnMissing(on: boolean) {
  cond.value.on_missing = on
  if (!on) props.graph.edges = props.graph.edges.filter(e => !(e.from === props.node.key && e.branch === 'missing'))
}

// ---------- labels that make their own keys ----------
// The key follows the label until someone edits the key by hand.
function relabel(item: { key: string, label?: string }, next: string, fallback: string) {
  if (!item.key || item.key === slug(item.label ?? '', fallback)) item.key = slug(next, fallback)
  item.label = next
}
// Questions' keys follow their name the way form fields' keys do: until the key is typed by hand, and never once
// the question is in the live flow or another step uses the key (a rule or an email would lose it). Unique among the siblings.
const keyTyped = new WeakSet<object>()
const keyUsed = (k: string) => new RegExp(`nodes\\.${props.node.key}\\.${k}(_any)?(?![a-z0-9_])`).test(JSON.stringify(props.graph))
function relabelQuestion(item: { key: string, label: string }, next: string, siblings: { key: string }[]) {
  const follows = !keyTyped.has(item) && !props.liveQuestions?.has(item.key) && !(item.key && keyUsed(item.key))
  item.label = next
  if (follows) item.key = uniqueKey(slug(next, 'question'), siblings.filter(x => x !== item).map(x => x.key))
}

// ---------- AI review ----------
const cvTextOptions = computed(() => fields.value.filter(f =>
  (f.nodeType === 'cv_parse' && f.path.endsWith('.text')) || (f.path.startsWith('form.') && ['text', 'string'].includes(f.type) && !f.protected)))
const cvTextRef = computed({
  get: () => c.value.cv_text_ref ?? '',
  set: (v: string) => {
    if (v) c.value.cv_text_ref = v
    else delete c.value.cv_text_ref
  },
})

// ---------- Read CV: also pull out ----------
const EXTRACT_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['list', 'List']] as const
function addExtract() {
  ;(c.value.extract ??= []).push({ key: '', label: '', type: 'text' })
}
function dropExtract(i: number) {
  c.value.extract.splice(i, 1)
  if (!c.value.extract.length) delete c.value.extract
}
const setHint = (f: any, v: string) => { if (v.trim()) f.hint = v; else delete f.hint }

// ---------- Check answers ----------
function setQuestionKind(q: any, kind: 'yes_no' | 'choice') {
  q.kind = kind
  if (kind === 'yes_no') delete q.options
  else q.options ??= [{ key: 'option_1', label: 'Option 1' }, { key: 'option_2', label: 'Option 2' }]
}
const addQuestion = () => c.value.questions.push({ key: uniqueKey('question', c.value.questions.map((q: any) => q.key)), label: '', question: '', kind: 'yes_no' })
const addOption = (q: any) => q.options.push({ key: uniqueKey('option', q.options.map((o: any) => o.key)), label: '' })
// what each question hands the next Decision, in the words the Decision shows
const givesText = (q: any) => q.kind === 'choice'
  ? (q.options ?? []).map((o: any) => o.label || o.key).join(', ').replace(/, ([^,]*)$/, ' or $1')
  : 'yes or no'

// ---------- person step ----------
const ht = computed(() => c.value as HumanTaskConfig)
function toggle(list: string[], id: string, on: boolean) {
  const i = list.indexOf(id)
  if (on && i < 0) list.push(id)
  if (!on && i >= 0) list.splice(i, 1)
}
const optNumber = (obj: any, k: string, raw: string) => {
  if (raw === '') delete obj[k]
  else obj[k] = Number(raw)
}
// Rating 1–5 is a number from 1 to 5 (the inbox shows small whole-number ranges as rating buttons)
const answerType = (s: ScorecardField) => s.type === 'number' && s.min === 1 && s.max === 5 ? 'rating' : s.type
function setAnswerType(s: ScorecardField, v: string) {
  delete s.min
  delete s.max
  if (v === 'rating') Object.assign(s, { type: 'number', min: 1, max: 5 })
  else s.type = v as ScorecardField['type']
}
// a fresh question, not a copy of the last one: yes/no is the simplest answer; the name box gets focus to fill in
function addScore() {
  const n = ht.value.scorecard.length
  ht.value.scorecard.push({ key: uniqueKey('question', ht.value.scorecard.map(s => s.key)), label: '', type: 'boolean', required: true })
  nextTick(() => document.getElementById(`sl-${props.node.key}-${n}`)?.focus())
}

// ---------- email preview ----------
const sample = computed(() => sampleContext(fields.value, props.job))
const preview = computed(() => ({
  subject: render(c.value.subject ?? '', sample.value),
  body: render(c.value.body ?? '', sample.value),
}))

// ---------- set values ----------
const SET_TYPES = [['string', 'Short text'], ['text', 'Long text'], ['number', 'Number'], ['boolean', 'Yes / no'], ['date', 'Date'], ['list', 'List']] as const
function setVarType(f: any, type: string) {
  f.type = type
  if (f.source.kind === 'literal') f.source.value = type === 'number' ? 0 : type === 'boolean' ? false : type === 'list' ? [] : ''
}
function setVarKind(f: any, kind: 'literal' | 'ref') {
  f.source = kind === 'literal' ? { kind, value: f.type === 'number' ? 0 : f.type === 'boolean' ? false : f.type === 'list' ? [] : '' } : { kind, ref: fields.value[0]?.path ?? '' }
}
function setLiteral(f: any, raw: string) {
  f.source.value = f.type === 'number' ? (raw === '' ? 0 : Number(raw)) : f.type === 'list' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw
}
const addVar = () => c.value.fields.push({ key: uniqueKey('value', c.value.fields.map((f: any) => f.key)), type: 'string', source: { kind: 'literal', value: '' } })

// booking link: off unless asked for; the server takes 15–240 minutes
const booking = computed(() => c.value.booking as { duration_min: number, where?: string } | undefined)
const setWhere = (v: string) => { if (v.trim()) c.value.booking.where = v; else delete c.value.booking.where }
function setBooking(on: boolean) {
  if (on) c.value.booking = { duration_min: 30 }
  else delete c.value.booking
}
const setDuration = (raw: string) => (c.value.booking.duration_min = Math.min(240, Math.max(15, Math.round(Number(raw) || 30))))

// ---------- request documents ----------
const dueChoices = computed(() => [...new Set([3, 7, 14, 30, ...(c.value.due_days === undefined ? [] : [c.value.due_days as number])])].sort((a, b) => a - b))

const fileFields = computed(() => props.form.filter(f => f.type === 'file'))
const OUTCOMES = [['hired', 'Hired'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn']] as const
const setRule = (b: { rule: Rule }, r: Rule) => (b.rule = r)
</script>

<template>
  <aside class="panel-side" :aria-label="`Settings for ${titleOf(node)}`">
    <header class="head" :data-slot="issues.length ? 'bad' : meta.slot === 'line' ? undefined : meta.slot">
      <div class="eyebrow"><Icon :name="meta.icon" :size="14" />{{ meta.noun }}</div>
      <h3>{{ titleOf(node) }}</h3>
      <div class="head-actions">
        <button v-if="!preset && canAsk" type="button" class="btn btn-quiet btn-sm" @click="explain">Explain</button>
        <button v-if="!preset && node.type !== 'application_received'" type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Save as a step template" title="Save as template (adds it to every job’s palette)" @click="emit('savePreset')">
          <Icon name="library" />
        </button>
        <button v-if="!preset && node.type !== 'application_received' && !readOnly" type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Delete step" title="Delete step" @click="emit('remove')">
          <Icon name="trash" />
        </button>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close settings" title="Close (Esc)" @click="emit('close')">
          <Icon name="x" />
        </button>
      </div>
    </header>

    <div v-if="issues.length" class="problems" role="status">
      <Icon name="alert" :size="16" />
      <ul><li v-for="(i, n) in issues" :key="n">{{ issueText(i, graph) }}</li></ul>
    </div>

    <fieldset :disabled="readOnly" class="body">
      <section class="sec">
        <div class="field">
          <label :for="`name-${node.key}`">{{ preset ? 'Template name' : 'Step name' }}</label>
          <input :id="`name-${node.key}`" v-model="label" :placeholder="derivedName" :required="preset">
          <p v-if="preset" class="hint">Steps added from this template start with this name.</p>
        </div>
        <slot name="extra" />
        <details v-if="!preset" class="adv">
          <summary>Advanced <span class="faint">(key: {{ node.key }}, used in rules and emails)</span></summary>
          <div class="field">
            <label :for="`key-${node.key}`">Key</label>
            <input
              :id="`key-${node.key}`" v-model.trim="keyDraft" class="mono" :disabled="keyLocked || readOnly"
              :aria-invalid="!!keyError" spellcheck="false" @change="commitKey" @keydown.enter="commitKey"
            >
            <p v-if="keyLocked" class="hint"><Icon name="lock" :size="12" class="inl" />Locked: this step is in the live workflow, so a new key would count as removing it.</p>
            <p v-else-if="keyError" class="error">{{ keyError }}</p>
            <p v-else class="hint">Other steps read this step’s answers as <code v-text="refHint" /></p>
          </div>
        </details>
      </section>

      <!-- start -->
      <section v-if="node.type === 'application_received'" class="sec">
        <p class="muted">Every application starts here, with the candidate’s answers to the form.</p>
      </section>

      <!-- read CV -->
      <template v-else-if="node.type === 'cv_parse'">
      <section class="sec">
        <div class="field">
          <label :for="`ff-${node.key}`">CV file field</label>
          <select v-if="fileFields.length" :id="`ff-${node.key}`" v-model="c.file_field">
            <option v-for="f in fileFields" :key="f.key" :value="f.key">{{ f.label }}</option>
          </select>
          <p v-else class="hint">The form has no file field. <NuxtLink :to="formHref">Add a file field in the Application form tab</NuxtLink></p>
        </div>
      </section>
      <section class="sec">
        <div class="legend">Standard fields</div>
        <ul class="fixed" aria-label="Standard fields">
          <li class="chip">Current title</li><li class="chip">Years of experience</li><li class="chip">Skills</li>
        </ul>
        <div class="legend">Additional fields <span class="faint">(up to 10)</span></div>
        <div v-for="(f, i) in c.extract ?? []" :key="i" class="row-card">
          <div class="rc-head">
            <span class="legend">Field {{ Number(i) + 1 }}</span>
            <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${f.label || 'fact'}`" title="Remove fact" @click="dropExtract(Number(i))"><Icon name="x" /></button>
          </div>
          <div class="field">
            <label :for="`xl-${node.key}-${i}`">Name</label>
            <input :id="`xl-${node.key}-${i}`" :value="f.label" placeholder="Notice period" @input="relabel(f, ($event.target as HTMLInputElement).value, 'fact')">
          </div>
          <div class="type-hint">
            <div class="field">
              <label :for="`xt-${node.key}-${i}`">Type</label>
              <select :id="`xt-${node.key}-${i}`" v-model="f.type">
                <option v-for="[v, l] in EXTRACT_TYPES" :key="v" :value="v">{{ l }}</option>
              </select>
            </div>
            <div class="field">
              <label :for="`xh-${node.key}-${i}`">Hint <span class="faint">(optional)</span></label>
              <input :id="`xh-${node.key}-${i}`" :value="f.hint ?? ''" maxlength="300" :placeholder="f.type === 'list' ? 'e.g. Food hygiene, first aid' : 'e.g. How soon they can start'" @input="setHint(f, ($event.target as HTMLInputElement).value)">
            </div>
          </div>
          <details class="adv">
            <summary>Advanced</summary>
            <div class="field">
              <label :for="`xk-${node.key}-${i}`">Key</label>
              <input :id="`xk-${node.key}-${i}`" v-model.trim="f.key" class="mono" spellcheck="false" placeholder="e.g. notice_period">
            </div>
          </details>
        </div>
        <button v-if="(c.extract?.length ?? 0) < 10" type="button" class="btn btn-sm add" @click="addExtract"><Icon name="plus" />Add a fact</button>
        <p class="hint">If the CV does not say, the fact stays empty. CV extraction never guesses.</p>
      </section>
      </template>

      <!-- AI review -->
      <section v-else-if="node.type === 'ai_review'" class="sec">
        <div class="legend">Scoring criteria <span class="faint">(0–100 each, up to 10)</span></div>
        <div v-for="(cr, i) in c.criteria" :key="i" class="row-card">
          <div class="rc-head">
            <span class="legend">Criterion {{ Number(i) + 1 }}</span>
            <button v-if="c.criteria.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${cr.label || 'criterion'}`" title="Remove criterion" @click="c.criteria.splice(i, 1)"><Icon name="x" /></button>
          </div>
          <div class="field">
            <label :for="`cl-${node.key}-${i}`">Name</label>
            <input :id="`cl-${node.key}-${i}`" :value="cr.label" placeholder="e.g. Customer service" @input="relabel(cr, ($event.target as HTMLInputElement).value, 'criterion')">
          </div>
          <div class="field">
            <label :for="`cd-${node.key}-${i}`">Description</label>
            <textarea :id="`cd-${node.key}-${i}`" v-model="cr.description" rows="2" placeholder="e.g. Has served customers in a shop, café or call centre" />
          </div>
          <details class="adv">
            <summary>Advanced</summary>
            <div class="field">
              <label :for="`ck-${node.key}-${i}`">Key</label>
              <input :id="`ck-${node.key}-${i}`" v-model.trim="cr.key" class="mono" spellcheck="false" placeholder="e.g. customer_service">
            </div>
          </details>
        </div>
        <button v-if="c.criteria.length < 10" type="button" class="btn btn-sm add" @click="c.criteria.push({ key: '', label: '', description: '' })"><Icon name="plus" />Add a criterion</button>
        <div class="field">
          <label :for="`cv-${node.key}`">CV source</label>
          <select :id="`cv-${node.key}`" v-model="cvTextRef">
            <option value="">None: score from the form answers only</option>
            <option v-for="f in cvTextOptions" :key="f.path" :value="f.path">{{ f.label }}</option>
          </select>
          <p class="hint">The AI only sees CV text and form answers that aren’t protected.</p>
        </div>
        <div class="field">
          <label :for="`in-${node.key}`">Extra instructions <span class="faint">(optional)</span></label>
          <textarea :id="`in-${node.key}`" v-model="c.instructions" rows="3" placeholder="e.g. Count open-source work as experience" />
        </div>
      </section>

      <!-- Check answers -->
      <template v-else-if="node.type === 'ai_check'">
      <section class="sec">
        <div class="legend">Screening questions <span class="faint">(up to 10)</span></div>
        <div v-for="(q, i) in c.questions" :key="i" class="row-card">
          <div class="rc-head">
            <span class="legend">Question {{ Number(i) + 1 }}</span>
            <button v-if="c.questions.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${q.label || 'question'}`" title="Remove question" @click="c.questions.splice(i, 1)"><Icon name="x" /></button>
          </div>
          <div class="field">
            <label :for="`qq-${node.key}-${i}`">Screening question</label>
            <textarea :id="`qq-${node.key}-${i}`" v-model="q.question" rows="2" maxlength="500" placeholder="Can they work Saturdays and Sundays?" />
          </div>
          <div class="field">
            <label :for="`ql-${node.key}-${i}`">Name</label>
            <input :id="`ql-${node.key}-${i}`" :value="q.label" placeholder="Weekends" @input="relabelQuestion(q, ($event.target as HTMLInputElement).value, c.questions)">
          </div>
          <details class="adv">
            <summary>Advanced</summary>
            <div class="field">
              <label :for="`qk-${node.key}-${i}`">Key</label>
              <input :id="`qk-${node.key}-${i}`" v-model.trim="q.key" class="mono" spellcheck="false" placeholder="e.g. weekends" @input="keyTyped.add(q)">
            </div>
          </details>
          <div class="field">
            <span class="legend" :id="`qa-${node.key}-${i}`">Answer</span>
            <div class="seg" role="radiogroup" :aria-labelledby="`qa-${node.key}-${i}`">
              <label><input type="radio" :name="`qa-${node.key}-${i}`" :checked="q.kind === 'yes_no'" @change="setQuestionKind(q, 'yes_no')"><span>Yes or no</span></label>
              <label><input type="radio" :name="`qa-${node.key}-${i}`" :checked="q.kind === 'choice'" @change="setQuestionKind(q, 'choice')"><span>Single choice</span></label>
            </div>
          </div>
          <div v-if="q.kind === 'choice'" class="field">
            <span class="legend">Choices <span class="faint">(2 to 8)</span></span>
            <div v-for="(o, j) in q.options" :key="j" class="opt">
              <input :value="o.label" :aria-label="`Choice ${Number(j) + 1}`" placeholder="e.g. Saturdays only" @input="relabel(o, ($event.target as HTMLInputElement).value, 'option')">
              <button v-if="q.options.length > 2" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${o.label || 'choice'}`" title="Remove choice" @click="q.options.splice(j, 1)"><Icon name="x" /></button>
            </div>
            <button v-if="q.options.length < 8" type="button" class="btn btn-sm btn-quiet add" @click="addOption(q)"><Icon name="plus" />Add a choice</button>
          </div>
        </div>
        <button v-if="c.questions.length < 10" type="button" class="btn btn-sm add" @click="addQuestion"><Icon name="plus" />Add a question</button>
      </section>
      <section class="sec">
        <div class="field">
          <label :for="`cv-${node.key}`">CV source</label>
          <select :id="`cv-${node.key}`" v-model="cvTextRef">
            <option value="">None: check the form answers only</option>
            <option v-for="f in cvTextOptions" :key="f.path" :value="f.path">{{ f.label }}</option>
          </select>
          <p class="hint">The AI only sees CV text and form answers that aren’t protected.</p>
        </div>
        <div class="gives">
          <span class="legend">Outputs</span>
          <dl>
            <template v-for="(q, i) in c.questions" :key="i"><dt>{{ q.label || q.key || 'Unnamed' }}</dt><dd>{{ givesText(q) }}</dd></template>
          </dl>
        </div>
      </section>
      </template>

      <!-- decision -->
      <section v-else-if="node.type === 'condition'" class="sec">
        <p v-if="!connected && !preset" class="note">Connect this step to an earlier one first; then you can pick fields from the steps before it.</p>
        <p class="hint">Checked top to bottom. The first branch that matches wins.</p>
        <div v-for="(b, i) in cond.branches" :key="i" class="row-card">
          <div class="rc-head">
            <span class="legend">Branch {{ i + 1 }}</span>
            <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="i === 0" :aria-label="`Move ${b.label} up`" title="Move up" @click="moveBranch(i, -1)"><Icon name="arrow-right" class="up" /></button>
            <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="i === cond.branches.length - 1" :aria-label="`Move ${b.label} down`" title="Move down" @click="moveBranch(i, 1)"><Icon name="arrow-right" class="down" /></button>
            <button v-if="cond.branches.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${b.label}`" title="Remove branch" @click="dropBranch(i)"><Icon name="x" /></button>
          </div>
          <div class="field">
            <label :for="`bl-${node.key}-${i}`">Name</label>
            <input :id="`bl-${node.key}-${i}`" :value="b.label" placeholder="e.g. Strong match" @input="relabelBranch(i, ($event.target as HTMLInputElement).value)">
          </div>
          <details class="adv" :open="!!branchKeyError(b.key)">
            <summary>Advanced</summary>
            <div class="field">
              <label :for="`bk-${node.key}-${i}`">Key</label>
              <input :id="`bk-${node.key}-${i}`" :value="b.key" class="mono" spellcheck="false" :aria-invalid="!!branchKeyError(b.key)" @change="renameBranch(i, ($event.target as HTMLInputElement).value.trim())">
            </div>
          </details>
          <p v-if="branchKeyError(b.key)" class="error">{{ branchKeyError(b.key) }}</p>
          <div class="legend sm">When</div>
          <RuleBuilder :model-value="b.rule" :fields="fields" :graph="graph" :read-only="readOnly" @update:model-value="setRule(b, $event)" />
          <label v-if="!preset" class="goes">
            <span>Goes to</span>
            <select :value="goesTo(b.key)" @change="emit('connect', b.key, ($event.target as HTMLSelectElement).value)">
              <option value="">Not connected</option>
              <option v-for="t in targets" :key="t.key" :value="t.key" :disabled="t.loops">{{ t.title }}{{ t.loops ? ' (would loop back)' : '' }}</option>
            </select>
          </label>
        </div>
        <button type="button" class="btn btn-sm add" @click="addBranch"><Icon name="plus" />Add a branch</button>
        <div class="row-card">
          <div class="legend sm">Otherwise</div>
          <p class="hint">When no branch matches.</p>
          <label v-if="!preset" class="goes">
            <span>Goes to</span>
            <select :value="goesTo('default')" @change="emit('connect', 'default', ($event.target as HTMLSelectElement).value)">
              <option value="">Not connected</option>
              <option v-for="t in targets" :key="t.key" :value="t.key" :disabled="t.loops">{{ t.title }}{{ t.loops ? ' (would loop back)' : '' }}</option>
            </select>
          </label>
        </div>
        <div class="row-card">
          <label class="check">
            <input type="checkbox" role="switch" :checked="cond.on_missing" @change="setOnMissing(($event.target as HTMLInputElement).checked)">
            <span><b>When data is missing</b><br><span class="hint">Send applications with a missing answer or score down their own branch, so no decision is made on data you don’t have.</span></span>
          </label>
          <label v-if="cond.on_missing && !preset" class="goes">
            <span>Goes to</span>
            <select :value="goesTo('missing')" @change="emit('connect', 'missing', ($event.target as HTMLSelectElement).value)">
              <option value="">Not connected</option>
              <option v-for="t in targets" :key="t.key" :value="t.key" :disabled="t.loops">{{ t.title }}{{ t.loops ? ' (would loop back)' : '' }}</option>
            </select>
          </label>
        </div>
      </section>

      <!-- person step -->
      <section v-else-if="node.type === 'human_task'" class="sec">
        <TemplateField v-model="ht.title" label="Task title" :fields="fields" :graph="graph" hide-protected placeholder="e.g. Call {{candidate.first_name}} about shifts" hint="What people see in their inbox." />
        <TemplateField v-model="ht.instructions" label="Instructions (optional)" multiline :fields="fields" :graph="graph" hide-protected placeholder="e.g. Ask which days they can work and when they can start." />
        <fieldset class="field">
          <legend class="legend">Assigned to</legend>
          <label class="check"><input v-model="ht.assignees.job_owner" type="checkbox">Job owner</label>
          <label v-for="r in roles" :key="r.id" class="check">
            <input type="checkbox" :checked="ht.assignees.roles.includes(r.id)" @change="toggle(ht.assignees.roles, r.id, ($event.target as HTMLInputElement).checked)">
            <span>Anyone with the role {{ r.name }}</span>
          </label>
          <template v-if="people">
            <div class="legend sm">Specific people</div>
            <div class="people">
              <label v-for="p in people" :key="p.id" class="check">
                <input type="checkbox" :checked="ht.assignees.users.includes(p.id)" @change="toggle(ht.assignees.users, p.id, ($event.target as HTMLInputElement).checked)">
                <span>{{ p.name }} <span class="faint">{{ p.email }}</span></span>
              </label>
            </div>
          </template>
        </fieldset>
        <p v-if="ht.offer" class="hint">Make offer: whoever does this step makes the offer from the candidate’s page or their inbox, and the letter is emailed. It moves on when the candidate answers on the link, or when you record their answer. Rules after it can read “Offer accepted”.</p>
        <template v-if="!ht.offer">
        <div class="legend">Scorecard</div>
        <div v-for="(s, i) in ht.scorecard" :key="i" class="row-card">
          <div class="rc-head">
            <span class="legend">Question {{ i + 1 }}</span>
            <button v-if="ht.scorecard.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${s.label || 'question'}`" title="Remove question" @click="ht.scorecard.splice(i, 1)"><Icon name="x" /></button>
          </div>
          <div class="field">
            <label :for="`sl-${node.key}-${i}`" class="sr-only">Question</label>
            <input :id="`sl-${node.key}-${i}`" :value="s.label" :placeholder="s.type === 'number' ? 'e.g. Problem solving (1–5)' : 'e.g. Would you hire them?'" @input="relabelQuestion(s, ($event.target as HTMLInputElement).value, ht.scorecard)">
          </div>
          <div class="row-2 two">
            <div class="field">
              <label :for="`st-${node.key}-${i}`">Answer</label>
              <select :id="`st-${node.key}-${i}`" :value="answerType(s)" @change="setAnswerType(s, ($event.target as HTMLSelectElement).value)">
                <option value="boolean">Yes / no</option>
                <option value="rating">Rating 1–5</option>
                <option value="number">Number</option>
                <option value="text">Text</option>
              </select>
            </div>
            <template v-if="answerType(s) === 'number'">
              <div class="field">
                <label :for="`smin-${node.key}-${i}`">Lowest</label>
                <input :id="`smin-${node.key}-${i}`" type="number" :value="s.min" placeholder="No limit" @input="optNumber(s, 'min', ($event.target as HTMLInputElement).value)">
              </div>
              <div class="field">
                <label :for="`smax-${node.key}-${i}`">Highest</label>
                <input :id="`smax-${node.key}-${i}`" type="number" :value="s.max" placeholder="No limit" @input="optNumber(s, 'max', ($event.target as HTMLInputElement).value)">
              </div>
            </template>
          </div>
          <label class="check"><input v-model="s.required" type="checkbox">Required</label>
          <details class="adv">
            <summary>Advanced</summary>
            <div class="field">
              <label :for="`sk-${node.key}-${i}`">Key</label>
              <input :id="`sk-${node.key}-${i}`" v-model.trim="s.key" class="mono" spellcheck="false" placeholder="e.g. would_hire" @input="keyTyped.add(s)">
            </div>
          </details>
        </div>
        <button v-if="ht.scorecard.length < 30" type="button" class="btn btn-sm add" @click="addScore"><Icon name="plus" />Add a question</button>
        </template>
        <div class="row-2 two">
          <div class="field">
            <label :for="`ms-${node.key}`">Scorecards required</label>
            <input :id="`ms-${node.key}`" v-model.number="ht.min_submissions" type="number" min="1" max="20" :aria-describedby="`ms-h-${node.key}`">
            <span :id="`ms-h-${node.key}`" class="hint">Before the candidate moves on</span>
          </div>
          <div class="field">
            <label :for="`dd-${node.key}`">Due within (days)</label>
            <input :id="`dd-${node.key}`" type="number" min="0" max="90" :value="ht.due_days" placeholder="No due date" @input="optNumber(ht, 'due_days', ($event.target as HTMLInputElement).value)">
          </div>
        </div>
        <p class="hint">With 2 or more, the step waits for that many scorecards (a panel) and averages the numbers.</p>
        <div v-if="!ht.offer" class="row-card">
          <label class="check">
            <input type="checkbox" role="switch" :checked="!!booking" @change="setBooking(($event.target as HTMLInputElement).checked)">
            <span><b>Book a time with the candidate</b><br><span class="hint">The people above offer a few times from their inbox, under Schedule. The candidate gets a link to pick one, or to ask for other times.</span></span>
          </label>
          <div v-if="booking" class="field dur">
            <label :for="`book-${node.key}`">Duration (minutes)</label>
            <input :id="`book-${node.key}`" type="number" min="15" max="240" step="15" :value="booking.duration_min" @change="setDuration(($event.target as HTMLInputElement).value)">
          </div>
          <div v-if="booking" class="field">
            <label :for="`where-${node.key}`">Location <span class="faint">optional</span></label>
            <input :id="`where-${node.key}`" :value="booking.where ?? ''" maxlength="300" placeholder="e.g. Tuas warehouse, 12 Tuas Ave 3. Ask for Priya at the front desk." @input="setWhere(($event.target as HTMLInputElement).value)">
            <span class="hint">Shown on the booking page, in the emails and in the calendar invite.</span>
          </div>
        </div>
      </section>

      <!-- request documents -->
      <section v-else-if="node.type === 'request_documents'" class="sec">
        <p class="hint">Emails the new hire a link to upload these. Moves on when every required one is in, whether they uploaded it or you ticked it off.</p>
        <div v-for="(d, i) in c.documents" :key="i" class="doc">
          <input v-model="d.label" :aria-label="`Document ${Number(i) + 1}`" placeholder="e.g. NRIC or work pass (both sides)" maxlength="200">
          <label class="check"><input v-model="d.required" type="checkbox">Required</label>
          <button v-if="c.documents.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove ${d.label || 'document'}`" title="Remove document" @click="c.documents.splice(i, 1)"><Icon name="x" /></button>
        </div>
        <button v-if="c.documents.length < 20" type="button" class="btn btn-sm add" @click="c.documents.push({ label: '', required: true })"><Icon name="plus" />Add a document</button>
        <fieldset class="field">
          <legend class="legend">Assigned to</legend>
          <label class="check"><input v-model="c.assignees.job_owner" type="checkbox">Job owner</label>
          <label v-for="r in roles" :key="r.id" class="check">
            <input type="checkbox" :checked="c.assignees.roles.includes(r.id)" @change="toggle(c.assignees.roles, r.id, ($event.target as HTMLInputElement).checked)">
            <span>Anyone with the role {{ r.name }}</span>
          </label>
          <template v-if="people">
            <div class="legend sm">Specific people</div>
            <div class="people">
              <label v-for="p in people" :key="p.id" class="check">
                <input type="checkbox" :checked="c.assignees.users.includes(p.id)" @change="toggle(c.assignees.users, p.id, ($event.target as HTMLInputElement).checked)">
                <span>{{ p.name }} <span class="faint">{{ p.email }}</span></span>
              </label>
            </div>
          </template>
        </fieldset>
        <div class="field">
          <label :for="`dd-${node.key}`">Due</label>
          <select :id="`dd-${node.key}`" :value="c.due_days ?? ''" @change="optNumber(c, 'due_days', ($event.target as HTMLSelectElement).value)">
            <option value="">No due date</option>
            <option v-for="d in dueChoices" :key="d" :value="d">{{ d }} days after it’s sent</option>
          </select>
        </div>
      </section>

      <!-- email -->
      <section v-else-if="node.type === 'send_email'" class="sec">
        <TemplateField v-model="c.subject" label="Subject" :fields="fields" :graph="graph" placeholder="e.g. Your application for {{job.title}}" />
        <TemplateField v-model="c.body" label="Message" multiline :fields="fields" :graph="graph" hint="Sent to the candidate. If a field is empty when it’s time to send, the email waits for you instead." />
        <div class="preview" aria-label="Preview with sample answers">
          <div class="eyebrow">Preview with sample answers</div>
          <div class="pv-meta"><span class="faint">To</span> Maya Okafor</div>
          <div class="pv-subject">{{ preview.subject || '(no subject)' }}</div>
          <div class="pv-body">{{ preview.body }}</div>
        </div>
      </section>

      <!-- set values -->
      <section v-else-if="node.type === 'set_variable'" class="sec">
        <p class="hint">Saves values that later steps can use.</p>
        <div v-for="(f, i) in c.fields" :key="i" class="row-card">
          <div class="row-2">
            <div class="field">
              <label :for="`vk-${node.key}-${i}`">Key</label>
              <input :id="`vk-${node.key}-${i}`" v-model.trim="f.key" class="mono" spellcheck="false" placeholder="e.g. start_date">
            </div>
            <div class="field">
              <label :for="`vt-${node.key}-${i}`">Type</label>
              <select :id="`vt-${node.key}-${i}`" :value="f.type" @change="setVarType(f, ($event.target as HTMLSelectElement).value)">
                <option v-for="[v, l] in SET_TYPES" :key="v" :value="v">{{ l }}</option>
              </select>
            </div>
            <button v-if="c.fields.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm rm" :aria-label="`Remove ${f.key}`" @click="c.fields.splice(i, 1)"><Icon name="x" /></button>
          </div>
          <div class="seg" role="radiogroup" :aria-label="`Value of ${f.key}`">
            <label><input type="radio" :name="`vs-${node.key}-${i}`" :checked="f.source.kind === 'literal'" @change="setVarKind(f, 'literal')"><span>Fixed value</span></label>
            <label><input type="radio" :name="`vs-${node.key}-${i}`" :checked="f.source.kind === 'ref'" @change="setVarKind(f, 'ref')"><span>Copy a field</span></label>
          </div>
          <template v-if="f.source.kind === 'literal'">
            <label v-if="f.type === 'boolean'" class="check"><input v-model="f.source.value" type="checkbox">Yes</label>
            <input
              v-else :type="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'" aria-label="Value"
              :value="Array.isArray(f.source.value) ? f.source.value.join(', ') : f.source.value"
              :placeholder="f.type === 'list' ? 'Separate with commas' : ''"
              @input="setLiteral(f, ($event.target as HTMLInputElement).value)"
            >
          </template>
          <select v-else v-model="f.source.ref" aria-label="Field to copy">
            <option v-for="x in fields" :key="x.path" :value="x.path">{{ x.label }}</option>
          </select>
        </div>
        <button v-if="c.fields.length < 30" type="button" class="btn btn-sm add" @click="addVar"><Icon name="plus" />Add a value</button>
      </section>

      <!-- end -->
      <section v-else-if="node.type === 'end'" class="sec">
        <fieldset class="field">
          <legend class="legend">Final outcome</legend>
          <div class="seg">
            <label v-for="[v, l] in OUTCOMES" :key="v"><input v-model="c.outcome" type="radio" :name="`out-${node.key}`" :value="v"><span>{{ l }}</span></label>
          </div>
        </fieldset>
      </section>

      <!-- the one way out, for steps that have one -->
      <section v-if="!preset && node.type !== 'condition' && node.type !== 'end'" class="sec">
        <label class="field">
          <span class="legend">Next step</span>
          <select :value="goesTo()" @change="emit('connect', undefined, ($event.target as HTMLSelectElement).value)">
            <option value="">Not connected</option>
            <option v-for="t in targets" :key="t.key" :value="t.key" :disabled="t.loops">{{ t.title }}{{ t.loops ? ' (would loop back)' : '' }}</option>
          </select>
        </label>
      </section>
    </fieldset>
  </aside>
</template>

<style scoped>
.panel-side { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--surface); border-left: 1px solid var(--line); }
.head { position: relative; padding: 22px 20px 14px; border-bottom: 1px solid var(--line); }
.head h3 { margin-top: 4px; padding-right: 72px; overflow-wrap: anywhere; }
.head .eyebrow { display: flex; align-items: center; gap: 6px; }
.head-actions { position: absolute; top: 14px; right: 12px; display: flex; gap: 2px; }
.problems { display: flex; gap: 10px; margin: 12px 16px 0; padding: 10px 12px; border-radius: var(--r-field); background: var(--bad-tint); color: var(--bad); font-size: var(--t-sm); font-weight: 500; }
.problems svg { flex: none; margin-top: 1px; }
.problems ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 32px; }
.sec { display: grid; gap: 14px; padding: 16px 20px; }
.sec + .sec { border-top: 1px solid var(--line); }
.legend.sm { font-size: var(--t-xs); color: var(--ink-2); }
.row-card { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-panel); }
.row-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) auto; gap: 8px; align-items: end; }
.row-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-items: end; }
.row-2 .rm { margin-bottom: 4px; }
.rc-head { display: flex; align-items: center; gap: 2px; margin: -4px -4px -2px 0; }
.rc-head .legend { flex: 1; }
.row-2.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.up { rotate: -90deg; }
.down { rotate: 90deg; }
.add { justify-self: start; }
.fixed { display: flex; flex-wrap: wrap; gap: 6px; margin: -6px 0 0; padding: 0; list-style: none; }
.type-hint { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 8px; align-items: end; }
.opt { display: grid; grid-template-columns: minmax(0, 1fr) var(--h-sm); gap: 6px; align-items: center; }
.gives { display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--r-panel); background: var(--sunk); font-size: var(--t-sm); }
.gives dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; }
.gives dt { font-weight: 600; }
.gives dd { margin: 0; color: var(--ink-2); overflow-wrap: anywhere; }
.goes { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: var(--t-sm); }
.goes span { flex: none; }
.doc { display: grid; grid-template-columns: minmax(0, 1fr) auto var(--h-sm); gap: 8px; align-items: center; }
.people { display: grid; gap: 8px; max-height: 220px; overflow-y: auto; }
.note { padding: 10px 12px; border-radius: var(--r-field); background: var(--warn-tint); color: var(--warn); font-size: var(--t-sm); font-weight: 500; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }
.inl { display: inline; vertical-align: -1px; margin-right: 4px; }
.mono { font-family: var(--mono); font-size: var(--t-sm); }
code { font-size: 12px; overflow-wrap: anywhere; }
.preview { display: grid; gap: 6px; padding: 14px 16px; border-radius: var(--r-panel); background: var(--sunk); }
.pv-meta { font-size: var(--t-sm); }
.pv-subject { font-weight: 600; }
.pv-body { white-space: pre-wrap; font-size: var(--t-sm); color: var(--ink); }
fieldset.field { gap: 10px; }
.dur input { width: 120px; }
fieldset.field > legend { margin-bottom: 10px; }
/* keys and {{nodes.…}} names: for people who wire rules by hand */
.adv > summary { cursor: pointer; font-size: var(--t-sm); color: var(--ink-2); width: fit-content; }
.adv[open] > summary { margin-bottom: 8px; }
</style>
