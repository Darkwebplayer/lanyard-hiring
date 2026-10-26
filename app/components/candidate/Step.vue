<script setup lang="ts">
import { type Assignment, type Run, type Timeline, fmtVal, humanise, stepName } from './Trace.vue'

// One step of the timeline. The detail is a native <details>; the current and stopped steps start open.
const props = defineProps<{
  tl: Timeline, run: Run, latest: boolean, manager: boolean
  users: { id: string, name: string }[] | null, retrying: boolean
}>()
const emit = defineEmits<{ retry: [], changed: [] }>()

const { me } = useMe()
const meta = computed(() => nodeMeta(props.run.nodeType))
const name = computed(() => stepName(props.tl, props.run.nodeKey))
const out = computed(() => props.run.output ?? null)
const err = computed(() => runErrorText(props.run.error, props.tl.nodes.some(n => n.type === 'human_task' && /review/i.test(`${n.key} ${n.label ?? ''}`))))
const waiting = computed(() => props.run.status === 'waiting_on_human')
const canRetry = computed(() => props.manager && props.latest && props.run.status === 'failed' && props.tl.application.status === 'active')
const human = computed(() => props.run.nodeType === 'human_task')
const hasDetail = computed(() => {
  const r = props.run
  if (r.status === 'cancelled' || r.status === 'failed' || human.value) return true
  if (r.nodeType === 'condition') return !!r.evaluation
  if (r.nodeType === 'send_email') return r.status === 'completed'
  return ['ai_review', 'ai_check', 'cv_parse', 'set_variable'].includes(r.nodeType) && !!out.value
})
// an older stopped step was retried or moved past, so only the latest one opens
const open = props.latest || waiting.value
const icon = computed(() => props.run.status === 'failed' ? 'stop' : meta.value.icon)
// Read CV's "Also pull out" facts: everything past the fixed outputs
const CV_FIXED = new Set(['text', 'skills', 'years_experience', 'current_title', 'file_sha256'])
const cvExtras = computed(() => Object.entries(out.value ?? {}).filter(([k]) => !CV_FIXED.has(k)))
const tone = computed(() => props.run.status === 'failed' ? 'bad' : props.run.status === 'cancelled' ? 'off' : meta.value.slot)

// Reassign: managers add and remove people while the task waits.
const canReassign = computed(() => props.manager && waiting.value)
const busy = ref(false)
const msg = ref('')
const confirming = ref<string | null>(null)
const pick = ref('')
const addable = computed(() => (props.users ?? []).filter(u => !props.run.assignments.some(a => a.userId === u.id && !a.closedAt)))
async function reassign(body: { add?: string[], remove?: string[] }) {
  busy.value = true
  msg.value = ''
  try {
    await api(`/api/runs/${props.run.id}/assignees`, { method: 'PUT', body })
    confirming.value = null
    pick.value = ''
    emit('changed')
  }
  catch (e) {
    msg.value = (e as ApiError).message
  }
  finally {
    busy.value = false
  }
}
// a Make offer step has no scorecard: the offer's answer closes it, so "didn't send" would read as a miss
const offerStep = computed(() => !!out.value && 'accepted' in out.value)
const state = (a: Assignment) =>
  a.submittedAt ? `Sent ${fmtDateTime(a.submittedAt)}` : offerStep.value ? 'Offer answered' : a.closedAt ? (waiting.value ? 'Removed' : 'Didn’t send') : 'Not sent yet'
const scoreRows = (v: Record<string, unknown>) => Object.entries(v).filter(([k]) => k !== 'notes')
</script>

<template>
  <li class="step" :data-tone="tone" :data-ask="`node:${run.nodeKey}`">
    <span class="dot" aria-hidden="true"><Icon :name="icon" :size="16" /></span>
    <details v-if="hasDetail" :open="open">
      <summary>
        <span class="name">{{ name }}</span>
        <RunStatus :status="run.status" :overdue="run.overdue" />
        <span v-if="run.attempt > 1" class="chip">Attempt {{ run.attempt }}</span>
        <time class="when" :datetime="run.createdAt">{{ fmtDateTime(run.createdAt) }}</time>
        <Icon name="chevron-down" :size="16" class="chev" />
      </summary>

      <div class="body">
        <p v-if="run.status === 'cancelled'" class="muted">Skipped: replaced by a move.</p>

        <div v-else-if="run.status === 'failed'" class="failed">
          <p><b>Failed: {{ err.what.charAt(0).toLowerCase() + err.what.slice(1) }}.</b><template v-if="latest">{{ ` ${err.fix}` }}</template></p>
          <button v-if="canRetry" class="btn btn-sm" :aria-busy="retrying" :disabled="retrying" @click="emit('retry')">
            <span v-if="retrying" class="spinner" /><Icon v-else name="retry" />Retry {{ name }}
          </button>
        </div>

        <CandidateScores v-else-if="run.nodeType === 'ai_review' && out" :output="out" :node-key="run.nodeKey" />

        <CandidateTrace v-else-if="run.nodeType === 'condition'" :tl="tl" :run="run" />

        <div v-else-if="run.nodeType === 'cv_parse' && out" class="cv">
          <p>
            <template v-if="out.current_title">{{ out.current_title }}</template>
            <template v-if="out.current_title && out.years_experience != null"> · </template>
            <template v-if="out.years_experience != null">{{ plural(Number(out.years_experience), 'year') }} of experience</template>
          </p>
          <ul v-if="Array.isArray(out.skills) && out.skills.length" class="skills" aria-label="Skills">
            <li v-for="s in out.skills" :key="String(s)" class="chip">{{ s }}</li>
          </ul>
          <dl v-if="cvExtras.length" class="kv">
            <div v-for="[k, v] in cvExtras" :key="k"><dt>{{ humanise(k) }}</dt><dd>{{ v == null ? 'Not in the CV' : fmtVal(v) }}</dd></div>
          </dl>
        </div>

        <p v-else-if="run.nodeType === 'send_email'" class="muted"><Icon name="check" :size="14" class="inl" />Sent to {{ tl.candidate.email }}</p>

        <dl v-else-if="run.nodeType === 'ai_check' && out" class="kv">
          <div v-for="(v, k) in out" :key="k"><dt>{{ humanise(String(k)) }}</dt><dd>{{ typeof v === 'string' ? humanise(v) : fmtVal(v) }}</dd></div>
        </dl>

        <dl v-else-if="run.nodeType === 'set_variable' && out" class="kv">
          <div v-for="(v, k) in out" :key="k"><dt>{{ humanise(String(k)) }}</dt><dd>{{ fmtVal(v) }}</dd></div>
        </dl>

        <template v-if="human">
          <p v-if="waiting && run.dueAt" class="due"><DueChip :due="run.dueAt" :overdue="run.overdue" /></p>
          <ul class="people">
            <li v-for="a in run.assignments" :key="a.userId" :class="{ gone: a.closedAt && !a.submittedAt }">
              <div class="who">
                <Avatar :name="a.name" :size="28" />
                <b>{{ a.name }}<span v-if="a.userId === me?.id" class="faint"> (you)</span></b>
                <span class="faint">{{ state(a) }}</span>
                <NuxtLink v-if="a.userId === me?.id && waiting && !a.submittedAt && !a.closedAt" :to="`/inbox/${run.id}`" class="btn btn-primary btn-sm rm">Fill in your scorecard</NuxtLink>
                <template v-if="canReassign && !a.submittedAt && !a.closedAt">
                  <button v-if="confirming !== a.userId" class="btn btn-quiet btn-sm rm" @click="confirming = a.userId">Remove</button>
                  <span v-else class="rm confirm">
                    <button class="btn btn-danger btn-sm" :disabled="busy" @click="reassign({ remove: [a.userId] })">Remove {{ a.name.split(' ')[0] }}</button>
                    <button class="btn btn-quiet btn-sm" @click="confirming = null">Keep</button>
                  </span>
                </template>
              </div>
              <template v-if="a.submittedAt">
                <p v-if="!a.values" class="hidden faint"><Icon name="eye-off" :size="14" />Hidden until you send yours</p>
                <template v-else>
                  <dl class="kv">
                    <div v-for="[k, v] in scoreRows(a.values)" :key="k"><dt>{{ humanise(k) }}</dt><dd>{{ fmtVal(v) }}</dd></div>
                  </dl>
                  <p v-if="a.values.notes" class="notes">“{{ a.values.notes }}”</p>
                </template>
              </template>
            </li>
          </ul>
          <template v-if="canReassign">
            <form v-if="users" class="add" @submit.prevent="pick && reassign({ add: [pick] })">
              <label :for="`add-${run.id}`" class="sr-only">Add an assignee to {{ name }}</label>
              <select :id="`add-${run.id}`" v-model="pick" required>
                <option value="" disabled>Add a person…</option>
                <option v-for="u in addable" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
              <button class="btn btn-sm" :disabled="busy">Add</button>
            </form>
          </template>
          <p v-if="msg" class="form-error" role="alert">{{ msg }}</p>
        </template>
      </div>
    </details>
    <div v-else class="row">
      <span class="name">{{ name }}</span>
      <RunStatus v-if="run.nodeType !== 'end' && run.nodeType !== 'application_received'" :status="run.status" />
      <time class="when" :datetime="run.createdAt">{{ fmtDateTime(run.createdAt) }}</time>
    </div>
  </li>
</template>

<style scoped>
.step { position: relative; display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding-bottom: 6px; }
.dot {
  position: relative; z-index: 1; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%;
  background: var(--surface); color: var(--ink-2); box-shadow: 0 0 0 1px var(--line-2), 0 0 0 4px var(--bg);
}
[data-tone="accent"] .dot { background: var(--accent-tint); color: var(--accent-ink); box-shadow: 0 0 0 1px var(--accent-line), 0 0 0 4px var(--bg); }
[data-tone="ink"] .dot { background: var(--machine); color: #fff; box-shadow: 0 0 0 4px var(--bg); }
[data-tone="bad"] .dot { background: var(--bad); color: #fff; box-shadow: 0 0 0 4px var(--bg); }
[data-tone="off"] .dot { background: var(--sunk); color: var(--ink-3); box-shadow: 0 0 0 1px var(--line), 0 0 0 4px var(--bg); }

summary, .row { display: flex; align-items: center; gap: 8px; min-height: 32px; flex-wrap: wrap; }
summary { list-style: none; cursor: pointer; border-radius: 10px; padding: 0 8px; margin: 0 -8px; }
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--hover); }
.name { font-weight: 600; min-width: 0; }
.when { margin-left: auto; color: var(--ink-3); font-size: var(--t-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
.chev { color: var(--ink-3); transition: rotate var(--t-micro) var(--ease); }
details[open] .chev { rotate: 180deg; }
[data-tone="off"] .name { color: var(--ink-2); font-weight: 500; }

.body { display: grid; gap: 12px; margin: 6px 0 14px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); box-shadow: var(--shadow-1); }
[data-tone="bad"] .body { border-color: color-mix(in oklch, var(--bad) 30%, var(--line)); }
.failed { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.failed p { color: var(--ink); max-width: 60ch; }
.failed b { color: var(--bad); }
.skills { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.inl { display: inline; vertical-align: -2px; margin-right: 6px; color: var(--ok); }
.kv { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 20px; font-size: var(--t-sm); }
.kv div { display: flex; gap: 6px; }
.kv dt { color: var(--ink-2); }
.kv dt::after { content: ":"; }
.kv dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.people { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.people > li { display: grid; gap: 6px; }
.people .kv, .people .notes, .people .hidden { margin-left: 38px; }
.who { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 30px; }
.who .faint { font-size: var(--t-sm); }
.gone b { color: var(--ink-2); font-weight: 500; text-decoration: line-through; text-decoration-color: var(--ink-3); }
.rm { margin-left: auto; }
.confirm { display: flex; gap: 4px; }
.notes { font-size: var(--t-sm); color: var(--ink-2); max-width: 70ch; }
.hidden { display: flex; gap: 6px; align-items: center; font-size: var(--t-sm); }
.add { display: flex; gap: 8px; align-items: center; max-width: 360px; }
.add select { min-height: var(--h-sm); font-size: var(--t-sm); }
.small { font-size: var(--t-sm); }
</style>
