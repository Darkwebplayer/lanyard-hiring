<script setup lang="ts">
import type { TaskRow } from '~/composables/useTasks'
import type { ScorecardField } from '~~/shared/workflow/registry'

interface Assignment { userId: string, name: string, assignedAt: string, submittedAt: string | null, closedAt: string | null, values: Record<string, unknown> | null }
interface TaskDetail extends TaskRow {
  scorecard: ScorecardField[], minSubmissions: number, canSubmit: boolean, assignments: Assignment[]
  instructions: string | null
}

const route = useRoute()
const router = useRouter()
const { me, isManager } = useMe()
const { inbox, refresh: refreshInbox } = useTasks()
const flash = useState<{ at: string, text: string, next?: { to: string, title: string } } | null>('inbox-flash', () => null)

const id = computed(() => route.params.runId as string)
const task = ref<TaskDetail | null>(null)
const loadError = ref<ApiError | null>(null)
const values = ref<Record<string, any>>({})
const fieldErrors = ref<Record<string, string>>({})
const formError = ref('')
const busy = ref(false)
// the opening after a sent scorecard is the one animated arrival; clicks and j/k stay instant
const arrived = flash.value?.at === route.path

async function load() {
  try {
    task.value = await api<TaskDetail>(`/api/tasks/${id.value}`)
    loadError.value = null
  }
  catch (e) {
    loadError.value = e as ApiError
  }
}
watch(id, () => {
  task.value = null
  values.value = {}
  fieldErrors.value = {}
  formError.value = ''
  load()
}, { immediate: true })
useHead({ title: () => task.value?.title ?? 'Inbox' })

const mine = computed(() => task.value?.assignments.find(a => a.userId === me.value?.id))
const submitted = computed(() => task.value?.assignments.filter(a => a.submittedAt).length ?? 0)
const isPanel = computed(() => !!task.value && (task.value.minSubmissions > 1 || task.value.assignments.length > 1))
const assignees = computed(() => task.value?.assignments.filter(a => !a.closedAt || a.submittedAt).map(a => a.name) ?? [])

// a small whole-number range is a rating: one press, no default
const isRating = (f: ScorecardField) => f.type === 'number' && f.min !== undefined && f.max !== undefined
  && Number.isInteger(f.min) && Number.isInteger(f.max) && f.max - f.min <= 10
const range = (f: ScorecardField) => Array.from({ length: f.max! - f.min! + 1 }, (_, i) => f.min! + i)
const bounds = (f: ScorecardField) => f.min !== undefined && f.max !== undefined ? `From ${f.min} to ${f.max}`
  : f.min !== undefined ? `${f.min} or more` : f.max !== undefined ? `Up to ${f.max}` : ''
const answer = (f: ScorecardField, v: unknown) => v === undefined || v === null || v === '' ? 'No answer'
  : f.type === 'boolean' ? (v ? 'Yes' : 'No')
  : isRating(f) ? `${v} of ${f.max}` : String(v)

function check(f: ScorecardField, v: unknown): string | null {
  const empty = v === undefined || v === null || v === '' || (typeof v === 'string' && !v.trim())
  if (empty) return f.required ? (f.type === 'text' ? 'Write a few words.' : f.type === 'boolean' ? 'Choose yes or no.' : isRating(f) ? 'Pick a rating.' : 'Enter a number.') : null
  if (f.type === 'number' && ((f.min !== undefined && (v as number) < f.min) || (f.max !== undefined && (v as number) > f.max))) return `${bounds(f)}.`
  return null
}

async function submit() {
  const t = task.value!
  formError.value = ''
  fieldErrors.value = {}
  const out: Record<string, unknown> = {}
  for (const f of t.scorecard) {
    const v = values.value[f.key]
    const err = check(f, v)
    if (err) fieldErrors.value[f.key] = err
    else if (v !== undefined && v !== null && v !== '') out[f.key] = typeof v === 'string' ? v.trim() : v
  }
  const firstBad = t.scorecard.find(f => fieldErrors.value[f.key])
  if (firstBad) {
    document.getElementById(`f-${firstBad.key}`)?.focus()
    return
  }
  busy.value = true
  try {
    const { completed } = await api<{ completed: boolean }>(`/api/tasks/${t.runId}/submit`, { method: 'POST', body: { values: out } })
    const before = inbox.value?.mine ?? []
    const at = before.findIndex(r => r.runId === t.runId)
    await refreshInbox()
    const left = inbox.value?.mine ?? []
    // the task after this one, else the earliest due
    const next = (at >= 0 ? before.slice(at + 1).find(r => left.some(l => l.runId === r.runId)) : undefined) ?? left[0]
    if (completed) {
      const to = next ? `/inbox/${next.runId}` : '/inbox'
      flash.value = { at: to, text: next ? `Scorecard sent for ${t.candidateName}. Next: ${next.title}` : `Scorecard sent for ${t.candidateName}.` }
      await router.replace({ path: to, query: route.query })
    }
    else {
      await load()
      const need = Math.max(1, (task.value?.minSubmissions ?? 1) - submitted.value)
      flash.value = {
        at: route.path,
        text: `Sent. Waiting for ${plural(need, 'more scorecard')}.`,
        next: next ? { to: `/inbox/${next.runId}`, title: next.title } : undefined,
      }
    }
  }
  catch (e) {
    const err = e as ApiError
    formError.value = err.message
    if (err.code === 'invalid_scorecard') {
      // issues read "key: message"
      for (const i of err.issues) {
        const key = i.message.split(':')[0]!
        if (t.scorecard.some(f => f.key === key)) fieldErrors.value[key] = 'This answer needs another look.'
      }
    }
    else if (err.status === 409 || err.status === 404) {
      await Promise.all([load(), refreshInbox()])
    }
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="loadError" class="empty">
    <h2>{{ loadError.status === 404 ? 'Task not found' : 'This task didn’t load' }}</h2>
    <p>{{ loadError.status === 404 ? 'This task isn’t yours, or it no longer exists.' : loadError.message }}</p>
    <button v-if="loadError.status !== 404" class="btn" @click="load"><Icon name="retry" />Retry</button>
    <NuxtLink v-else to="/inbox" class="btn">Back to your tasks</NuxtLink>
  </div>

  <div v-else-if="!task" class="stack" aria-busy="true" aria-label="Loading task">
    <div class="card head sk-head">
      <span class="skeleton" style="width:44px;height:44px;border-radius:50%" />
      <div class="sk-lines"><span class="skeleton" style="height:22px;width:62%" /><span class="skeleton" style="height:14px;width:40%" /></div>
    </div>
    <div class="card form-card sk-lines">
      <span v-for="i in 4" :key="i" class="skeleton" :style="{ height: '14px', width: `${70 - i * 9}%` }" />
    </div>
  </div>

  <div v-else class="stack" :class="{ arrived }">
    <header class="card head" data-slot="accent">
      <div class="head-top">
        <Avatar :name="task.candidateName" :size="44" />
        <div class="head-txt">
          <p class="job-line">
            <NuxtLink v-if="isManager" :to="`/jobs/${task.jobId}`">{{ task.jobTitle }}</NuxtLink>
            <template v-else>{{ task.jobTitle }}</template>
          </p>
          <h2 class="title">{{ task.title }}</h2>
          <p class="meta">
            <NuxtLink :to="`/candidates/${task.applicationId}`" class="who">{{ task.candidateName }}’s application</NuxtLink>
            <RunStatus v-if="task.status !== 'waiting_on_human'" :status="task.status" />
            <DueChip v-else :due="task.dueAt" :overdue="task.overdue" />
          </p>
        </div>
      </div>
      <p v-if="task.instructions" class="instructions">{{ task.instructions }}</p>
    </header>

    <form v-if="task.canSubmit" class="card form-card" novalidate @submit.prevent="submit">
      <h3>Scorecard</h3>
      <template v-for="f in task.scorecard" :key="f.key">
        <fieldset v-if="isRating(f) || f.type === 'boolean'" class="field q" :aria-describedby="fieldErrors[f.key] ? `e-${f.key}` : undefined">
          <legend class="legend">{{ f.label }}<span v-if="!f.required" class="opt">Optional</span></legend>
          <div class="pills" :role="f.required ? 'radiogroup' : undefined" :aria-required="f.required || undefined" :aria-invalid="!!fieldErrors[f.key] || undefined">
            <template v-if="f.type === 'boolean'">
              <label v-for="(o, i) in [{ v: true, t: 'Yes' }, { v: false, t: 'No' }]" :key="o.t" class="pill wide">
                <input :id="i === 0 ? `f-${f.key}` : undefined" v-model="values[f.key]" type="radio" :name="f.key" :value="o.v"><span>{{ o.t }}</span>
              </label>
            </template>
            <template v-else>
              <label v-for="n in range(f)" :key="n" class="pill">
                <input :id="n === f.min ? `f-${f.key}` : undefined" v-model="values[f.key]" type="radio" :name="f.key" :value="n"><span>{{ n }}</span>
              </label>
            </template>
          </div>
          <p v-if="fieldErrors[f.key]" :id="`e-${f.key}`" class="error"><Icon name="alert" :size="14" />{{ fieldErrors[f.key] }}</p>
        </fieldset>

        <div v-else class="field q">
          <label :for="`f-${f.key}`">{{ f.label }}<span v-if="!f.required" class="opt">Optional</span></label>
          <input
            v-if="f.type === 'number'" :id="`f-${f.key}`" v-model.number="values[f.key]" type="number" inputmode="decimal" step="any" class="num"
            :min="f.min" :max="f.max" :required="f.required" :aria-invalid="!!fieldErrors[f.key] || undefined"
            :aria-describedby="`h-${f.key}${fieldErrors[f.key] ? ` e-${f.key}` : ''}`"
          >
          <textarea
            v-else :id="`f-${f.key}`" v-model="values[f.key]" rows="3" :required="f.required"
            :aria-invalid="!!fieldErrors[f.key] || undefined" :aria-describedby="fieldErrors[f.key] ? `e-${f.key}` : undefined"
          />
          <p v-if="f.type === 'number' && bounds(f)" :id="`h-${f.key}`" class="hint">{{ bounds(f) }}</p>
          <p v-if="fieldErrors[f.key]" :id="`e-${f.key}`" class="error"><Icon name="alert" :size="14" />{{ fieldErrors[f.key] }}</p>
        </div>
      </template>

      <p v-if="formError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ formError }}</p>
      <div class="foot">
        <button class="btn btn-primary" :aria-busy="busy" :disabled="busy">
          <span v-if="busy" class="spinner" />Submit scorecard
        </button>
        <span class="faint">{{ isPanel ? 'The panel sees it once they’ve sent theirs. ' : '' }}You can’t change it after you send it.</span>
      </div>
    </form>

    <section v-else class="card form-card">
      <template v-if="mine?.submittedAt">
        <div class="ro-head"><h3>Your scorecard</h3><span class="chip chip-ok"><Icon name="check" />Sent {{ fmtDateTime(mine.submittedAt) }}</span></div>
        <dl class="answers">
          <div v-for="f in task.scorecard" :key="f.key"><dt>{{ f.label }}</dt><dd :class="{ faint: answer(f, mine.values?.[f.key]) === 'No answer' }">{{ answer(f, mine.values?.[f.key]) }}</dd></div>
        </dl>
      </template>
      <p v-else-if="task.status !== 'waiting_on_human'" class="reason"><Icon name="lock" :size="16" />This task is closed, so it can’t take a scorecard any more.</p>
      <p v-else-if="!mine" class="reason"><Icon name="person" :size="16" />This task is for {{ assignees.join(', ') || 'nobody right now' }}. You can follow it here; only they can send scorecards.</p>
      <p v-else class="reason"><Icon name="lock" :size="16" />You were taken off this task, so you can’t send a scorecard.</p>
      <p v-if="formError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ formError }}</p>
    </section>

    <section v-if="isPanel" class="card panel-card" aria-labelledby="panel-h">
      <div class="ro-head">
        <h3 id="panel-h">Panel</h3>
        <span class="progress">
          <span class="pips" aria-hidden="true"><i v-for="i in task.minSubmissions" :key="i" :class="{ on: i <= submitted }" /></span>
          {{ Math.min(submitted, task.minSubmissions) }} of {{ task.minSubmissions }} scorecards in
        </span>
      </div>
      <ul class="people">
        <li v-for="a in task.assignments" :key="a.userId">
          <Avatar :name="a.name" :size="28" />
          <div class="p-body">
            <p><b>{{ a.name }}</b><span v-if="a.userId === me?.id" class="faint"> (you)</span></p>
            <template v-if="a.submittedAt">
              <p class="state ok"><Icon name="check" :size="14" />Submitted {{ fmtAgo(a.submittedAt).replace('Yesterday', 'yesterday') }}</p>
              <p v-if="a.userId !== me?.id && !a.values" class="state faint"><Icon name="eye-off" :size="14" />Answers hidden until you send yours</p>
            </template>
            <p v-else-if="a.closedAt" class="state faint">Taken off this task</p>
            <p v-else class="state faint">Not yet</p>
            <dl v-if="a.values && a.userId !== me?.id" class="answers small">
              <div v-for="f in task.scorecard" :key="f.key"><dt>{{ f.label }}</dt><dd :class="{ faint: answer(f, a.values[f.key]) === 'No answer' }">{{ answer(f, a.values[f.key]) }}</dd></div>
            </dl>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 20px; }
.arrived { animation: rise var(--t-move) var(--ease); }

.head { padding: 28px 28px 24px; }
.head-top { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 16px; align-items: start; }
.head-txt { min-width: 0; }
.title { font-size: var(--t-2xl); letter-spacing: -0.015em; line-height: 1.15; overflow-wrap: anywhere; }
.job-line { font-size: var(--t-sm); font-weight: 500; color: var(--ink-2); margin-bottom: 4px; }
.job-line a { color: inherit; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 10px; }
.who { font-weight: 600; }
.instructions { margin-top: 18px; padding: 14px 16px; border-radius: var(--r-field); background: var(--sunk); white-space: pre-line; color: var(--ink); max-width: 70ch; }

.form-card, .panel-card { padding: 24px 28px; display: grid; gap: 22px; }
.sk-head { display: flex; gap: 16px; align-items: center; }
.sk-lines { display: grid; gap: 12px; flex: 1; }
.q { gap: 10px; }
.q legend { padding: 0; margin-bottom: 10px; }
.opt { margin-left: 8px; font-weight: 500; color: var(--ink-2); }
.num { max-width: 160px; font-variant-numeric: tabular-nums; }

/* rating and yes/no: radios drawn as pills; arrow keys move within a group */
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { position: relative; }
.pill input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; margin: 0; cursor: pointer; }
.pill span {
  display: inline-grid; place-items: center; min-width: 44px; height: var(--h-md); padding: 0 14px; border-radius: var(--r-pill);
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2); font-weight: 600; font-variant-numeric: tabular-nums;
  transition: background var(--t-micro) var(--ease), color var(--t-micro) var(--ease), box-shadow var(--t-micro) var(--ease);
}
.pill.wide span { min-width: 72px; }
.pill:hover span { box-shadow: inset 0 0 0 1px var(--ink-3); }
.pill input:checked + span { background: var(--accent); color: #fff; box-shadow: none; }
.pill input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
[aria-invalid="true"] .pill span { box-shadow: inset 0 0 0 1px var(--bad); }

.foot { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; padding-top: 4px; }
.foot .faint { font-size: var(--t-sm); }

.ro-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.reason { display: flex; gap: 10px; align-items: flex-start; color: var(--ink-2); }
.reason svg { margin-top: 2px; flex: none; }
.answers { margin: 0; display: grid; gap: 12px; }
.answers div { display: grid; grid-template-columns: minmax(140px, 220px) minmax(0, 1fr); gap: 16px; }
.answers dt { color: var(--ink-2); }
.answers dd { margin: 0; font-weight: 500; white-space: pre-line; overflow-wrap: anywhere; }
.answers.small { margin-top: 10px; gap: 6px; font-size: var(--t-sm); }

.progress { display: inline-flex; gap: 10px; align-items: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.pips { display: inline-flex; gap: 4px; }
.pips i { width: 18px; height: 5px; border-radius: 9px; background: var(--line-2); }
.pips i.on { background: var(--accent); }
.people { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
.people li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; }
.p-body { min-width: 0; }
.state { display: flex; gap: 6px; align-items: center; font-size: var(--t-sm); margin-top: 2px; }
.state.ok { color: var(--ok); }
</style>
