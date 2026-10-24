<script setup lang="ts">
import { parseCsv, splitName } from '~~/shared/csv'
import type { FormField, GraphNode } from '~~/shared/workflow/types'
import { resting } from '~/lib/board'

// Its own page, not a tab: the job's tab shell (pages/jobs/[id].vue) would wrap a child route, and an
// import is a short errand that ends back on the pipeline.
definePageMeta({ path: '/jobs/:id/import' })

const route = useRoute()
const id = route.params.id as string
const { detail, error, refresh } = useJob(id)
if (!detail.value) refresh()
const job = computed(() => detail.value?.job)
const published = computed(() => detail.value?.published)
useHead({ title: () => `Import · ${job.value?.title ?? 'Job'}` })

const MAX = 2000 // the server's limit per request
const step = ref<1 | 2 | 3>(1)

// ---------- 1 upload ----------
interface Sheet { name: string, header: string[], data: string[][] }
const sheet = ref<Sheet | null>(null)
const fileError = ref('')
const dragging = ref(false)
async function readFile(f: File | undefined) {
  if (!f) return
  fileError.value = ''
  if (/\.xlsx?$/i.test(f.name)) return (fileError.value = 'That’s an Excel file. Save it as CSV first (File › Save as › CSV), then choose it here.')
  const rows = parseCsv(await f.text())
  const header = rows[0]?.map(h => h.trim()) ?? []
  // a trailing blank line is no one; blank lines in the middle stay, so row numbers match the spreadsheet
  while (rows.length > 1 && rows.at(-1)!.every(c => !c.trim())) rows.pop()
  const data = rows.slice(1)
  if (!header.some(Boolean)) return (fileError.value = 'This file is empty.')
  if (!data.length) return (fileError.value = 'This file has a header row but nobody under it.')
  // ponytail: one request holds 2,000 rows; above that we refuse rather than split, because duplicates
  // across two halves would only show after the first half is already in
  if (data.length > MAX) return (fileError.value = `This file has ${data.length.toLocaleString()} rows. Import up to ${MAX.toLocaleString()} at a time: split it into smaller files and import each one.`)
  sheet.value = { name: f.name, header, data }
  map.value = autoMatch(header)
  valueStep.value = {}
  step.value = 2
}
function onDrop(e: DragEvent) {
  dragging.value = false
  readFile(e.dataTransfer?.files[0])
}

// ---------- 2 match columns ----------
type Target = '' | 'first_name' | 'last_name' | 'full' | 'email' | 'phone' | 'note' | 'stage' | `f:${string}`
const formFields = computed<FormField[]>(() => (published.value?.form ?? []).filter(f => f.type !== 'file'))
const map = ref<Target[]>([])

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const GUESS: [RegExp, Target][] = [
  [/^(firstname|first|givenname|forename)$/, 'first_name'],
  [/^(lastname|last|surname|familyname)$/, 'last_name'],
  [/^(name|fullname|candidate|candidatename|applicant|applicantname)$/, 'full'],
  [/email/, 'email'],
  [/phone|mobile|tel|cell/, 'phone'],
  [/note|comment/, 'note'],
  [/^(status|stage|step)$/, 'stage'],
]
// Last resort: the one question sharing the most words with the header, at least half of them
// ("LinkedIn profile" → "LinkedIn URL", "Notice (weeks)" → "Notice period (weeks)").
// ponytail: plain word overlap, so "Current salary" can land on "Expected salary"; the row shows it to fix
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1)
function byWords(h: string) {
  const hw = words(h)
  const scored = formFields.value.map(f => ({ f, n: words(f.label).filter(w => hw.includes(w)).length })).sort((a, b) => b.n - a.n)
  const [best, next] = scored
  return best && best.n * 2 >= hw.length && best.n > (next?.n ?? 0) ? best.f : undefined
}
function autoMatch(header: string[]): Target[] {
  const used = new Set<Target>()
  return header.map((h) => {
    const n = norm(h)
    const field = formFields.value.find(f => norm(f.label) === n || norm(f.key) === n)
    const guess = GUESS.find(([re]) => re.test(n))?.[1]
    const loose = !field && !guess ? byWords(h) : undefined
    const t: Target = field ? `f:${field.key}` : guess ?? (loose ? `f:${loose.key}` : '')
    if (!t || used.has(t)) return ''
    used.add(t)
    return t
  })
}
// one column per target: choosing a target another column had moves it here
function setTarget(i: number, t: Target) {
  map.value = map.value.map((x, j) => (j === i ? t : t && x === t ? '' : x))
}
const example = (i: number) => sheet.value?.data.find(r => r[i]?.trim())?.[i]?.trim() ?? ''
const hasName = computed(() => map.value.includes('full') || map.value.includes('last_name'))
const hasEmail = computed(() => map.value.includes('email'))
const ready = computed(() => hasName.value && hasEmail.value)

// ---------- where they start ----------
const graph = computed(() => published.value?.workflow)
const byKey = computed(() => new Map((graph.value?.nodes ?? []).map(n => [n.key, n])))
const groups = computed(() => {
  const g = graph.value
  if (!g) return []
  const stages = g.stages ?? []
  const staged = new Set(stages.flatMap(s => s.nodeKeys))
  const out = stages.map(s => ({ label: s.name, nodes: s.nodeKeys.map(k => byKey.value.get(k)).filter((n): n is GraphNode => !!n && resting(n.type)) }))
  const rest = g.nodes.filter(n => resting(n.type) && !staged.has(n.key))
  if (rest.length) out.push({ label: stages.length ? 'Other steps' : 'Steps', nodes: rest })
  return out.filter(x => x.nodes.length)
})
const stageOf = (key: string) => groups.value.find(x => x.nodes.some(n => n.key === key))?.label
const where = (key: string | null) => key ? [stageOf(key), nodeLabel(byKey.value.get(key)!)].filter(Boolean).join(' · ') : 'the start of the flow'

// Imported people have no files, so a step that reads the CV stops for each of them (Read CV), or
// judges them on nothing (an AI review reading the CV text, whose low scores may send a rejection).
// Returns the first such step on their way, so the warning can name it.
const readsCv = (n: GraphNode | undefined) => n?.type === 'cv_parse' || ((n?.type === 'ai_review' || n?.type === 'ai_check') && !!(n.config as { cv_text_ref?: string } | undefined)?.cv_text_ref)
function cvAhead(from: string | null): GraphNode | undefined {
  const g = graph.value
  if (!g) return
  const first = from ?? g.nodes.find(n => n.type === 'application_received')?.key
  const seen = new Set(first ? [first] : [])
  const queue = [...seen]
  while (queue.length) {
    const n = byKey.value.get(queue.shift()!)
    if (readsCv(n)) return n
    for (const e of g.edges) if (e.from === n?.key && !seen.has(e.to)) (seen.add(e.to), queue.push(e.to))
  }
}
const start = ref<string | null>(null)
// start at the first step with nothing ahead that reads the CV; the flow's own start if every step has one
watch(groups, (gs) => {
  if (start.value && byKey.value.has(start.value)) return
  start.value = gs.flatMap(x => x.nodes).find(n => !cvAhead(n.key))?.key ?? null
}, { immediate: true })
const startCv = computed(() => cvAhead(start.value))

// "Use to pick their stage": each different value in that column points at a step
const VALUE_CAP = 25
const stageCol = computed(() => map.value.indexOf('stage'))
const values = computed(() => {
  if (stageCol.value < 0 || !sheet.value) return []
  const counts = new Map<string, number>()
  for (const r of sheet.value.data) {
    const v = r[stageCol.value]?.trim()
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts].map(([v, n]) => ({ v, n }))
})
const valueStep = ref<Record<string, string>>({})
watch(values, (vs) => {
  if (vs.length > VALUE_CAP) return
  const nodes = groups.value.flatMap(x => x.nodes)
  for (const { v } of vs) {
    if (v in valueStep.value) continue
    const n = norm(v)
    valueStep.value[v] = nodes.find(x => norm(nodeLabel(x)) === n)?.key
      ?? groups.value.find(x => norm(x.label) === n)?.nodes[0]?.key ?? ''
  }
})
const useValues = computed(() => values.value.length > 0 && values.value.length <= VALUE_CAP)

// ---------- rows for the server ----------
interface ImportRow { first_name: string, last_name: string, email: string, phone?: string, answers?: Record<string, unknown>, note?: string, start?: string }
function toAnswer(f: FormField, v: string): unknown {
  if (f.type === 'list') return v.split(/[;,\n]/).map(s => s.trim()).filter(Boolean)
  if (f.type === 'enum') return f.options?.find(o => o.toLowerCase() === v.toLowerCase()) ?? v
  if (f.type === 'boolean') return /^(yes|y)$/i.test(v) ? 'true' : /^(no|n)$/i.test(v) ? 'false' : v
  return v
}
// every data row in file order, blank ones too: rows[i] is spreadsheet row i + 2
function buildRows(): ImportRow[] {
  const fields = new Map(formFields.value.map(f => [f.key, f]))
  return (sheet.value?.data ?? []).map((cells) => {
    const row: ImportRow = { first_name: '', last_name: '', email: '' }
    const answers: Record<string, unknown> = {}
    map.value.forEach((t, i) => {
      const v = cells[i]?.trim() ?? ''
      if (!t || !v) return
      if (t === 'full') {
        const s = splitName(v)
        row.first_name ||= s.first
        row.last_name ||= s.last
      }
      else if (t === 'stage') { if (useValues.value && valueStep.value[v]) row.start = valueStep.value[v] }
      // ponytail: notes over 2,000 characters are cut, not refused; nobody's spreadsheet note is that long on purpose
      else if (t === 'note') row.note = v.slice(0, 2000)
      else if (t.startsWith('f:')) answers[t.slice(2)] = toAnswer(fields.get(t.slice(2))!, v)
      else row[t as 'first_name' | 'last_name' | 'email' | 'phone'] = v
    })
    if (Object.keys(answers).length) row.answers = answers
    return row
  })
}

// ---------- dry run, as the matching changes ----------
interface Summary { create: number, duplicates: string[], invalid: { row: number, problem: string }[], imported?: number }
const summary = ref<Summary | null>(null)
const checking = ref(false)
const checkError = ref('')
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
async function check() {
  if (step.value !== 2 || !ready.value) return (summary.value = null)
  const mine = ++seq
  checking.value = true
  checkError.value = ''
  try {
    const s = await api<Summary>(`/api/jobs/${id}/import`, { method: 'POST', body: { rows: buildRows(), start: start.value, dryRun: true } })
    if (mine === seq) summary.value = s
  }
  catch (e) {
    if (mine === seq) (summary.value = null, checkError.value = toApiError(e).message)
  }
  finally {
    if (mine === seq) checking.value = false
  }
}
watch([map, start, valueStep, step], () => {
  clearTimeout(timer)
  timer = setTimeout(check, 300)
}, { deep: true })

// ---------- 3 import ----------
const importing = ref(false)
const importError = ref('')
const result = ref<Summary | null>(null)
async function runImport() {
  importing.value = true
  importError.value = ''
  try {
    result.value = await api<Summary>(`/api/jobs/${id}/import`, { method: 'POST', body: { rows: buildRows(), start: start.value } })
    step.value = 3
  }
  catch (e) { importError.value = toApiError(e).message }
  finally { importing.value = false }
}
function again() {
  sheet.value = null
  summary.value = null
  result.value = null
  step.value = 1
}
const skipped = (s: Summary) => s.duplicates.length + s.invalid.length
</script>

<template>
  <div class="page imp">
    <header class="head">
      <NuxtLink :to="`/jobs/${id}`" class="crumb"><Icon name="arrow-left" :size="14" />{{ job?.title ?? 'Job' }} · Pipeline</NuxtLink>
      <h1>Import candidates</h1>
    </header>

    <div v-if="error && !detail" class="empty" role="alert">
      <h2>This job didn’t load</h2>
      <p>{{ error.message }}</p>
      <button type="button" class="btn" @click="refresh"><Icon name="retry" />Try again</button>
    </div>

    <div v-else-if="!detail" class="sk" aria-busy="true" aria-label="Loading the job">
      <span class="skeleton" style="height: 24px; width: 50%" />
      <span class="skeleton" style="height: 220px; border-radius: var(--r-panel)" />
    </div>

    <div v-else-if="!published" class="empty">
      <h2>Publish this job first</h2>
      <p>Imported people join the published flow, and this job doesn’t have one yet.</p>
      <NuxtLink :to="`/jobs/${id}/flow`" class="btn">Go to the flow<Icon name="arrow-right" /></NuxtLink>
    </div>

    <template v-else>
      <ol class="steps" aria-label="Progress">
        <li :class="step > 1 ? 'done' : 'on'" :aria-current="step === 1 ? 'step' : undefined">
          <i><Icon v-if="step > 1" name="check" :size="14" /><template v-else>1</template></i>Upload
          <span v-if="sheet && step > 1" class="file">{{ sheet.name }} · {{ plural(sheet.data.length, 'row') }}</span>
        </li>
        <li :class="step > 2 ? 'done' : step === 2 ? 'on' : ''" :aria-current="step === 2 ? 'step' : undefined">
          <i><Icon v-if="step > 2" name="check" :size="14" /><template v-else>2</template></i>Match columns
        </li>
        <li :class="step === 3 ? 'done' : ''" :aria-current="step === 3 ? 'step' : undefined">
          <i><Icon v-if="step === 3" name="check" :size="14" /><template v-else>3</template></i>Import
        </li>
      </ol>

      <!-- 1 -->
      <section v-if="step === 1" class="upload" aria-labelledby="up-h">
        <h2 id="up-h" class="sr-only">Upload</h2>
        <label class="drop" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
          <Icon name="upload" :size="24" />
          <b>Choose a CSV file</b>
          <span class="muted">or drop it here</span>
          <input type="file" accept=".csv,text/csv" class="file-input" aria-describedby="up-hint" @change="readFile(($event.target as HTMLInputElement).files?.[0])">
        </label>
        <p v-if="fileError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ fileError }}</p>
        <p id="up-hint" class="hint">One person per row, with a header row on top. From Excel or Google Sheets, save or download the sheet as CSV. Up to {{ MAX.toLocaleString() }} people at a time.</p>
      </section>

      <!-- 2 -->
      <template v-else-if="step === 2 && sheet">
        <div class="panel table-wrap">
          <table class="table map">
            <thead><tr><th>Column in your file</th><th>Example</th><th class="to">Goes into</th></tr></thead>
            <tbody>
              <tr v-for="(h, i) in sheet.header" :key="i">
                <td><b>{{ h || `Column ${i + 1}` }}</b></td>
                <td class="ex">{{ example(i) || '—' }}</td>
                <td>
                  <select :value="map[i]" :class="{ off: !map[i] }" :aria-label="`${h || `Column ${i + 1}`} goes into`" @change="setTarget(i, ($event.target as HTMLSelectElement).value as Target)">
                    <option value="">Don’t import</option>
                    <optgroup label="Their details">
                      <option value="full">Full name (split into first and last)</option>
                      <option value="first_name">First name</option>
                      <option value="last_name">Last name</option>
                      <option value="email">Email</option>
                      <option value="phone">Phone</option>
                    </optgroup>
                    <optgroup v-if="formFields.length" label="Application form">
                      <option v-for="f in formFields" :key="f.key" :value="`f:${f.key}`">{{ f.label }}</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="note">Note on their timeline</option>
                      <option value="stage">Use to pick their stage…</option>
                    </optgroup>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!ready" class="need" role="status">
          <Icon name="alert" :size="16" />Choose which column holds {{ !hasEmail && !hasName ? 'their name and which holds their email' : !hasEmail ? 'their email' : 'their name' }}. Everyone needs both.
        </p>

        <div class="lower">
          <div class="where">
            <div class="field">
              <label for="imp-start">Start everyone at</label>
              <select id="imp-start" v-model="start" aria-describedby="imp-start-h">
                <option :value="null">The start of the flow</option>
                <optgroup v-for="g in groups" :key="g.label" :label="g.label">
                  <option v-for="n in g.nodes" :key="n.key" :value="n.key">{{ nodeLabel(n) }}</option>
                </optgroup>
              </select>
              <p v-if="startCv" id="imp-start-h" class="warn"><Icon name="alert" :size="14" />{{ startCv.type === 'cv_parse' ? `${nodeLabel(startCv)} is on their way from here. Imported people have no CV file, so that step stops for each of them until someone moves them on.` : `${nodeLabel(startCv)} reads the CV and is on their way from here. Imported people have no CV, so it would score them on nothing and may reject them.` }} Start after it to avoid that.</p>
              <p v-else id="imp-start-h" class="hint">Their flow runs from here, as if they had just arrived at {{ where(start) }}.</p>
            </div>

            <div v-if="stageCol >= 0" class="values">
              <p class="label">Each value in “{{ sheet.header[stageCol] }}”</p>
              <p v-if="!useValues" class="hint">
                {{ values.length ? `This column has ${values.length} different values, too many to match one by one. Choose a column with a few, like a status, or don’t import it.` : 'This column is empty.' }}
              </p>
              <ul v-else>
                <li v-for="x in values" :key="x.v">
                  <span class="v"><b>{{ x.v }}</b> <span class="faint">{{ x.n }}</span></span>
                  <select v-model="valueStep[x.v]" :aria-label="`People with “${x.v}” start at`">
                    <option value="">Same as everyone</option>
                    <optgroup v-for="g in groups" :key="g.label" :label="g.label">
                      <option v-for="n in g.nodes" :key="n.key" :value="n.key">{{ nodeLabel(n) }}</option>
                    </optgroup>
                  </select>
                  <Icon v-if="valueStep[x.v] && cvAhead(valueStep[x.v]!)" name="alert" :size="16" class="warn-ico" :aria-label="`${nodeLabel(cvAhead(valueStep[x.v]!)!)} needs a CV and is on their way from ${where(valueStep[x.v]!)}`" />
                </li>
              </ul>
            </div>
          </div>

          <div class="summary" aria-live="polite">
            <template v-if="!ready"><p class="muted">The count shows once their name and email are matched.</p></template>
            <template v-else-if="checkError">
              <p class="bad"><Icon name="alert" :size="14" />{{ checkError }}</p>
              <button type="button" class="btn btn-sm" @click="check"><Icon name="retry" />Check again</button>
            </template>
            <template v-else-if="!summary"><p class="muted"><span class="spinner" />Checking your file…</p></template>
            <template v-else>
              <p class="big" :class="{ stale: checking }">{{ summary.create ? `${plural(summary.create, 'person', 'people')} will be imported` : 'Nobody new to import' }}</p>
              <details v-if="summary.duplicates.length">
                <summary>{{ summary.duplicates.length }} already applied to this job (skipped)</summary>
                <ul class="probs"><li v-for="e in summary.duplicates" :key="e">{{ e }}</li></ul>
              </details>
              <details v-if="summary.invalid.length" class="warn-d">
                <summary>{{ summary.invalid.length === 1 ? '1 row can’t be imported' : `${summary.invalid.length} rows can’t be imported` }} (skipped)</summary>
                <ul class="probs"><li v-for="p in summary.invalid" :key="p.row"><b>Row {{ p.row }}</b> {{ p.problem }}</li></ul>
              </details>
              <p class="faint small">Their source shows as “{{ sourceLabel('import') }}”. Consent: not collected.</p>
            </template>
          </div>
        </div>

        <p v-if="importError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ importError }}</p>
        <div class="foot">
          <button type="button" class="btn" @click="again">Back</button>
          <button
            type="button" class="btn btn-primary" :disabled="!ready || !summary?.create || checking || importing" :aria-busy="importing" @click="runImport"
          >
            <span v-if="importing" class="spinner" />{{ summary?.create ? `Import ${plural(summary.create, 'person', 'people')}` : 'Import' }}
          </button>
        </div>
      </template>

      <!-- 3 -->
      <section v-else-if="step === 3 && result" class="card done" aria-labelledby="done-h">
        <span class="tick" aria-hidden="true"><Icon name="check" :size="22" /></span>
        <h2 id="done-h">{{ result.imported ? `${plural(result.imported, 'person', 'people')} imported` : 'Nobody was imported' }}</h2>
        <p v-if="result.imported" class="muted">
          They start at {{ where(start) }}<template v-if="useValues && Object.values(valueStep).some(Boolean)">, or the step their “{{ sheet?.header[stageCol] }}” points to</template>.
          <template v-if="result.imported > 50"> With this many, it can take a minute for everyone to show on the board.</template>
        </p>
        <p v-if="skipped(result)" class="muted">{{ plural(skipped(result), 'row') }} skipped: {{ [result.duplicates.length && `${result.duplicates.length} already applied`, result.invalid.length && `${result.invalid.length} with problems`].filter(Boolean).join(', ') }}.</p>
        <div class="done-act">
          <NuxtLink :to="`/jobs/${id}`" class="btn btn-primary">See them on the pipeline<Icon name="arrow-right" /></NuxtLink>
          <button type="button" class="btn" @click="again">Import another file</button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* one column at the mock's width: an errand, not a workspace */
.imp { max-width: 980px; display: grid; gap: 20px; align-content: start; }
.head h1 { margin-top: 2px; }
.sk { display: grid; gap: 16px; }

/* steps: done is ok green, current is ink, later is quiet, as in the mock */
.steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 8px 24px; flex-wrap: wrap; }
.steps li { display: flex; align-items: center; gap: 8px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-3); }
.steps i { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: var(--t-xs); background: var(--sunk); }
.steps .done { color: var(--ok); }
.steps .done i { background: var(--ok); color: #fff; }
.steps .on { color: var(--ink); }
.steps .on i { background: var(--ink); color: #fff; }
.steps .file { font-weight: 400; color: var(--ink-2); }

.upload { display: grid; gap: 12px; max-width: 640px; }
.drop {
  position: relative; display: grid; justify-items: center; gap: 4px; padding: 40px 24px; border: 1.5px dashed var(--line-2); border-radius: var(--r-card);
  background: var(--surface); color: var(--ink-2); cursor: pointer; transition: background var(--t-micro) var(--ease), border-color var(--t-micro) var(--ease);
}
.drop b { color: var(--ink); font-size: var(--t-lg); }
.drop:hover, .drop.dragging { border-color: var(--accent); background: var(--accent-tint); }
.drop:has(:focus-visible) { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
/* the native input covers the whole area, so clicks and drops land on it */
.file-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }

.map td { vertical-align: middle; }
.map .to { width: 300px; }
.ex { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.map select { width: 100%; min-height: var(--h-sm); }
.map select.off { color: var(--ink-3); }
.need { display: flex; gap: 8px; align-items: center; color: var(--warn); font-weight: 500; font-size: var(--t-sm); }

.lower { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.where { display: grid; gap: 16px; min-width: 0; }
.warn { display: flex; gap: 6px; align-items: flex-start; font-size: var(--t-sm); color: var(--warn); font-weight: 500; }
.warn svg { margin-top: 3px; flex: none; }
.values { display: grid; gap: 8px; }
.values .label { font-weight: 600; font-size: var(--t-sm); }
.values ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.values li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 16px; gap: 8px; align-items: center; }
.values .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); }
.values select { min-height: var(--h-sm); }
.warn-ico { color: var(--warn); }

/* the summary is a sunk slip beside the choices, like the mock: what will happen, before it does */
.summary { display: grid; gap: 8px; padding: 16px; border-radius: var(--r-panel); background: var(--sunk); font-size: var(--t-sm); min-width: 0; align-content: start; }
.summary .big { font-size: var(--t-lg); font-weight: 600; color: var(--ink); transition: opacity var(--t-micro) var(--ease); }
.summary .stale { opacity: 0.55; }
.summary .muted { display: flex; gap: 8px; align-items: center; }
.summary .bad { display: flex; gap: 6px; align-items: center; color: var(--bad); font-weight: 500; }
.summary details summary { cursor: pointer; color: var(--ink-2); }
.summary .warn-d summary { color: var(--warn); font-weight: 500; }
.probs { margin: 6px 0 0; padding: 8px 10px; list-style: none; display: grid; gap: 4px; max-height: 220px; overflow-y: auto; border-radius: 10px; background: var(--surface); overflow-wrap: anywhere; }
.probs b { font-variant-numeric: tabular-nums; margin-right: 6px; }
.small { font-size: var(--t-sm); }

.foot { display: flex; justify-content: space-between; gap: 8px; }

.done { display: grid; justify-items: start; gap: 8px; padding: 32px 28px; max-width: 640px; }
.tick { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--ok-tint); color: var(--ok); margin-bottom: 4px; }
.done-act { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
@media (prefers-reduced-motion: reduce) { .summary .big, .drop { transition: none; } }
</style>
