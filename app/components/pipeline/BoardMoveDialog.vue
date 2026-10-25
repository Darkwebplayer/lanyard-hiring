<script lang="ts">
import type { Pos, Row } from '~/lib/board'

// One slice of a move. `ids`: these people, sent 25 per call (the API's limit) and moved at once.
// No `ids`: everyone at `from` but `except`, queued on the server.
export interface Part { from: Pos, ids?: string[], except?: string[] }
// What was dropped where. `name` when it is one person; `seen` = how many the screen showed.
export interface Drop { parts: Part[], name?: string, seen: number, fromLabel: string, to: Row | null }
export interface Moved { id: string, moved: boolean, currentNodeKey: string | null, status: 'active' | 'closed', outcome: string | null }
export interface MoveResult { moved: Moved[], queued: { from: Pos, to: Pos, n: number }[] }

// Loaded once per visit and shared by the board, the list and their dialogs.
let names: Promise<Map<string, string>> | null = null
export const loadNames = () => names ??= api<{ id: string, name: string }[]>('/api/users/assignable')
  .then(r => new Map(r.map(u => [u.id, u.name])))
  .catch(() => (names = null, new Map<string, string>()))
let reasons: Promise<string[]> | null = null
const loadReasons = () => reasons ??= api<{ rejectReasons: string[] }>('/api/settings')
  .then(s => s.rejectReasons)
  .catch((e) => { reasons = null; throw e })
</script>

<script setup lang="ts">
import type { FormField, Graph } from '~~/shared/workflow/types'
import { rejectionEmailNode, rejectionSubject } from '~~/shared/workflow/graph'
import { dropEffects, needsReason, posId } from '~/lib/board'

const props = defineProps<{ jobId: string, targets: (Row & { group: string })[], graph: Graph | null, nameOf: (id: string) => string | undefined }>()
const emit = defineEmits<{ moved: [res: MoveResult] }>()
const BATCH = 25
const toast = useToast()

const dlg = ref<HTMLDialogElement>()
const drop = ref<Drop | null>(null)
const toId = ref('')
const reason = ref('')
const reasonCode = ref('')
const notify = ref(false) // closing as rejected: off by default, they may have been told already
const { detail: job } = useJob(props.jobId)
const answers = ref<Record<string, any>>({}) // field values as typed; answerBody() converts them
const busy = ref(false)
const err = ref('')
const issues = ref<string[]>([])
const progress = ref<{ done: number, total: number } | null>(null)
const rejectList = ref<string[] | null>(null)
const rejectErr = ref('')
// the server's count for a whole-group move, at the moment of asking: some may have moved on since the board loaded
const check = ref<{ count: number, notInVersion: number } | null>(null)
const checking = ref(false)

const to = computed(() => props.targets.find(t => t.id === toId.value) ?? null)
// a part can go anywhere but where it is; closing a closed application needs a reopen first
const fits = (from: Pos, t: Row) => posId(from) !== t.id && !('closed' in from && 'closed' in t.pos)
const parts = computed(() => (drop.value?.parts ?? []).filter(p => !to.value || fits(p.from, to.value)))
const choices = computed(() => props.targets.filter(t => drop.value?.parts.some(p => fits(p.from, t))))
const groups = computed(() => [...new Set(choices.value.map(c => c.group))])
const whole = computed(() => parts.value.length === 1 && !parts.value[0]!.ids)

function open(d: Drop) {
  drop.value = d
  toId.value = d.to?.id ?? ''
  reason.value = ''
  reasonCode.value = ''
  notify.value = false
  answers.value = {}
  err.value = ''
  issues.value = []
  progress.value = null
  check.value = null
  dlg.value!.showModal()
  // straight to what's still missing: the target if it wasn't dropped, else the first thing to fill in
  nextTick(() => (dlg.value?.querySelector<HTMLElement>(d.to ? '.bmove-body :is(input, textarea, select)' : '#bmove-to'))?.focus())
}
defineExpose({ open })


// the target stage's own questions, asked on any move into it by hand (files can't be asked here)
const ask = computed<FormField[]>(() => {
  const t = to.value
  if (!t || !('node' in t.pos)) return []
  const node = t.pos.node
  return (props.graph?.stages?.find(s => s.nodeKeys.includes(node))?.ask ?? []).filter(f => f.type !== 'file')
})
function answerBody() {
  const out: Record<string, unknown> = {}
  for (const f of ask.value) {
    const v = answers.value[f.key]
    if (f.type === 'boolean') out[f.key] = !!v
    else if (f.type === 'list') { if (listItems(v).length) out[f.key] = listItems(v) }
    else if (v === undefined || v === '') continue
    else if (f.type === 'number') out[f.key] = Number(v)
    else out[f.key] = v
  }
  return out
}

const reasonNeeded = computed(() => !!to.value && parts.value.some(p => needsReason(props.graph, p.from, to.value!.pos)))

const body = (p: Part, extra: object = {}) => ({
  from: p.from,
  to: 'node' in to.value!.pos ? { node: to.value!.pos.node } : { close: to.value!.pos.closed },
  ...(reason.value.trim() && { reason: reason.value.trim() }),
  ...(rejecting.value && reasonCode.value && { reasonCode: reasonCode.value }),
  ...(closingRejected.value && notify.value && { notify: true }),
  ...(ask.value.length && { answers: answerBody() }),
  ...(p.except?.length && { except: p.except }),
  ...extra,
})
watch([toId, drop], async () => {
  check.value = null
  if (!to.value || !whole.value) return
  checking.value = true
  try { check.value = await api(`/api/jobs/${props.jobId}/moves`, { method: 'POST', body: body(parts.value[0]!, { dryRun: true }) }) }
  catch (e) { err.value = toApiError(e).message }
  finally { checking.value = false }
})

const picked = computed(() => parts.value.reduce((n, p) => n + (p.ids?.length ?? 0), 0))
const n = computed(() => whole.value ? check.value?.count ?? drop.value?.seen ?? 0 : picked.value)
const skipped = computed(() => (drop.value?.parts ?? []).reduce((s, p) => s + (p.ids?.length ?? 0), 0) - picked.value)
const who = computed(() => n.value === 1 && drop.value?.name ? drop.value.name : plural(n.value, 'person', 'people'))
const reopening = computed(() => !!drop.value?.parts.every(p => 'closed' in p.from))
const title = computed(() => {
  if (!to.value) return `Move ${who.value}`
  if (rejecting.value) return `Reject ${who.value}?`
  if ('closed' in to.value.pos) return `Close ${who.value} as ${to.value.pos.closed}?`
  return `${reopening.value ? 'Reopen' : 'Move'} ${who.value} ${reopening.value ? 'at' : 'to'} ${to.value.label}?`
})
const closingRejected = computed(() => !!to.value && 'closed' in to.value.pos && to.value.pos.closed === 'rejected')
const effects = computed(() => to.value
  ? dropEffects(props.graph, to.value.pos, props.nameOf, n.value > 1).map(e => notify.value && closingRejected.value ? { ...e, text: e.text.replace('No email is sent.', `${n.value === 1 ? 'They’re' : 'Each is'} emailed the rejection.`) } : e)
  : [])
// closing as rejected, or a drop on a step whose path ends in a rejection ("Otherwise → Rejection email"):
// either way the team's reason is asked, so the "why rejected" counts see the common path too
const rejecting = computed(() => effects.value.some(e => e.outcome === 'rejected'))
watch(rejecting, async (r) => {
  if (!r || rejectList.value) return
  rejectErr.value = ''
  try {
    rejectList.value = await loadReasons()
    // the reason is the one thing a reject needs, so it gets focus once the list is in
    if (drop.value?.to && dlg.value?.open) nextTick(() => dlg.value?.querySelector<HTMLElement>('input[name=bmove-code]')?.focus())
  }
  catch (e) { rejectErr.value = toApiError(e).message }
}, { immediate: true })
const emails = computed(() => effects.value.some(e => e.kind === 'email'))
const action = computed(() => {
  if (!to.value) return 'Move'
  if (rejecting.value) return `Reject${emails.value ? ' and email' : ''} ${who.value}`
  if ('closed' in to.value.pos) return `Close as ${to.value.pos.closed}`
  return `${reopening.value ? 'Reopen' : 'Move'}${emails.value ? ' and email' : ''} ${who.value}`
})
const ICON: Record<string, string> = { assign: 'person', booking: 'calendar', auto: 'ai', email: 'mail', close: 'flag' }
const blocked = computed(() => (!!check.value && check.value.count === 0) || (!!to.value && !parts.value.length))

const ERRORS: Record<string, string> = {
  reason_code_required: 'Pick a reason from the list.',
  unknown_reason_code: 'That reason was taken off the list. Pick another.',
  invalid_answers: 'Some answers need another look.',
}

// Moves the picked people 25 at a time and keeps count. A refusal of the request itself (422) is the same for
// every batch, so it stops at once and nothing more is sent; other failures are counted and the rest go on.
async function submit() {
  if (!to.value || !drop.value) return
  busy.value = true
  err.value = ''
  issues.value = []
  const res: MoveResult = { moved: [], queued: [] }
  const batches = parts.value.flatMap((p): { p: Part, ids: string[] | null }[] => p.ids
    ? Array.from({ length: Math.ceil(p.ids.length / BATCH) }, (_, i) => ({ p, ids: p.ids!.slice(i * BATCH, (i + 1) * BATCH) }))
    : [{ p, ids: null }])
  progress.value = batches.length > 1 ? { done: 0, total: picked.value } : null
  let lastErr = ''
  for (const b of batches) {
    try {
      const r = await api<{ moved?: Moved[], queued?: number }>(`/api/jobs/${props.jobId}/moves`, { method: 'POST', body: body(b.p, b.ids ? { ids: b.ids } : {}) })
      res.moved.push(...r.moved ?? [])
      if (r.queued) res.queued.push({ from: b.p.from, to: to.value.pos, n: r.queued })
    }
    catch (e) {
      const x = toApiError(e)
      if (x.status === 422) {
        err.value = ERRORS[x.code] ?? x.message
        issues.value = x.issues.map(i => i.message)
        break
      }
      if (!b.ids) { err.value = x.message; break }
      lastErr = x.message // counted below as not moved; the other batches still go
    }
    if (progress.value) progress.value.done += b.ids?.length ?? 0
  }
  busy.value = false
  if (res.moved.length || res.queued.length) emit('moved', res)
  if (err.value && !res.moved.length) return // nothing happened: fix and try again
  const stayed = res.moved.filter(m => !m.moved).length
  const left = picked.value - res.moved.length
  if (left > 0) {
    err.value = `${plural(res.moved.length - stayed, 'person', 'people')} moved. ${plural(left, 'person', 'people')} didn’t: ${err.value || lastErr}`
    drop.value = { ...drop.value, parts: [] } // they're still on the list to pick again; the dialog only reports now
    return
  }
  dlg.value!.close()
  if (stayed) toast.show(`${plural(stayed, 'person', 'people')} had already moved on, so they stayed where they are.`)
}
</script>

<template>
  <dialog ref="dlg" class="dialog bmove" aria-labelledby="bmove-h" @click="e => e.target === dlg && !busy && dlg!.close()">
    <form v-if="drop" @submit.prevent="submit">
      <div class="dialog-body bmove-body">
        <div>
          <h2 id="bmove-h">{{ title }}</h2>
          <p class="muted sub">From {{ drop.fromLabel }}</p>
        </div>

        <div v-if="!drop.to" class="field">
          <label for="bmove-to">{{ reopening ? 'Reopen at' : 'Move to' }}</label>
          <select id="bmove-to" v-model="toId" required>
            <option value="" disabled>Pick a step or an outcome</option>
            <optgroup v-for="g in groups" :key="g" :label="g">
              <option v-for="c in choices.filter(x => x.group === g)" :key="c.id" :value="c.id">{{ 'closed' in c.pos ? `Close as ${c.label.toLowerCase()}` : c.label }}</option>
            </optgroup>
          </select>
        </div>

        <ul v-if="to" class="effects" aria-live="polite">
          <li v-for="(e, i) in effects" :key="i" :class="{ loud: e.kind !== 'close', final: e.kind === 'email' }"><Icon :name="ICON[e.kind] ?? 'move'" :size="16" />{{ e.text }}</li>
          <li v-if="whole && !checking && check && check.count !== drop.seen"><Icon name="clock" :size="16" />{{ check.count > drop.seen ? `${(check.count - drop.seen).toLocaleString()} more arrived` : `${(drop.seen - check.count).toLocaleString()} moved on` }} since the board loaded. All {{ check.count.toLocaleString() }} there now will move.</li>
          <li v-if="check?.notInVersion"><Icon name="lock" :size="16" />{{ check.notInVersion.toLocaleString() }} are on an older version of the flow without {{ to.label }}. They stay where they are.</li>
          <li v-if="skipped"><Icon name="lock" :size="16" />{{ plural(skipped, 'person is', 'people are') }} there already or closed, so they stay as they are.</li>
          <li v-if="whole && n > 1"><Icon name="move" :size="16" />Moves run in the background. The board updates as they land.</li>
          <li v-if="checking" class="faint"><span class="spinner" />Checking who can move…</li>
        </ul>

        <fieldset v-if="rejecting" class="field">
          <legend class="legend">Reason</legend>
          <p v-if="rejectErr" class="error" role="alert"><Icon name="alert" :size="16" />{{ rejectErr }}</p>
          <div v-else-if="!rejectList" class="faint"><span class="spinner" /></div>
          <div v-else class="opts">
            <label v-for="r in rejectList" :key="r" class="opt check"><input v-model="reasonCode" type="radio" name="bmove-code" :value="r" required>{{ r }}</label>
          </div>
        </fieldset>

        <label v-if="closingRejected" class="check notify">
          <input v-model="notify" type="checkbox">
          <span>Send {{ n === 1 ? 'them' : 'each of them' }} the rejection email<br><span class="faint">{{ graph && rejectionEmailNode(graph) ? 'The one from this job’s flow' : 'A short, polite note' }}: “{{ rejectionSubject(graph, job?.job.title ?? 'this job') }}”. Off by default, because you may already have told them. Each email sent shows on the person’s page.</span></span>
        </label>

        <div v-for="f in ask" :key="f.key" class="field">
          <label v-if="f.type === 'boolean'" class="check"><input v-model="answers[f.key]" type="checkbox">{{ f.label }}</label>
          <template v-else>
            <label :for="`bmove-a-${f.key}`">{{ f.label }}<span v-if="!f.required" class="faint"> (optional)</span></label>
            <select v-if="f.type === 'enum'" :id="`bmove-a-${f.key}`" v-model="answers[f.key]" :required="f.required">
              <option value="" disabled>Pick one</option>
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <ListInput v-else-if="f.type === 'list'" v-model="answers[f.key]" :id="`bmove-a-${f.key}`" :label="f.label" :max="f.max" :required="f.required" />
            <textarea v-else-if="f.type === 'text'" :id="`bmove-a-${f.key}`" v-model="answers[f.key]" :required="f.required" rows="2" />
            <input v-else :id="`bmove-a-${f.key}`" v-model="answers[f.key]" :type="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'" :required="f.required" :min="f.type === 'number' ? f.min : undefined" :max="f.type === 'number' ? f.max : undefined">
          </template>
        </div>

        <div v-if="to" class="field">
          <label for="bmove-reason">{{ reasonNeeded ? 'Reason' : 'Note' }}<span v-if="!reasonNeeded" class="faint"> (optional)</span></label>
          <textarea id="bmove-reason" v-model="reason" :required="reasonNeeded" maxlength="1000" rows="2" aria-describedby="bmove-reason-hint" :placeholder="rejecting ? 'e.g. Can’t do weekend shifts' : reasonNeeded ? 'e.g. Owner wants to meet them this week' : 'e.g. Spoke on the phone, keen to start'" />
          <span id="bmove-reason-hint" class="hint">
            <template v-if="rejecting">Only your team sees it, in {{ n === 1 ? 'the candidate’s' : 'each candidate’s' }} history.</template>
            <template v-else-if="!reasonNeeded">Follows the flow, so no reason needed.</template>
            <template v-else>Kept in {{ n === 1 ? 'the candidate’s' : 'each candidate’s' }} history with your name.</template>
          </span>
        </div>
      </div>
      <div class="dialog-foot">
        <p v-if="progress && busy" class="moving" role="status"><span class="spinner" />Moving {{ progress.done.toLocaleString() }} of {{ progress.total.toLocaleString() }}…</p>
        <div v-if="err" class="form-error" role="alert">
          <Icon name="alert" :size="16" />
          <div>{{ err }}<ul v-if="issues.length" class="issues"><li v-for="i in issues" :key="i">{{ i }}</li></ul></div>
        </div>
        <p v-else-if="blocked" class="form-error" role="alert"><Icon name="alert" :size="16" />Nobody here can move there now.</p>
        <template v-if="drop.parts.length">
          <button type="button" class="btn" :disabled="busy" @click="dlg!.close()">Cancel</button>
          <button class="btn" :class="emails || rejecting ? 'btn-danger' : 'btn-primary'" :disabled="busy || checking || blocked || !to" :aria-busy="busy">
            <span v-if="busy" class="spinner" />{{ action }}
          </button>
        </template>
        <button v-else type="button" class="btn" @click="dlg!.close()">Close</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.bmove { width: min(500px, calc(100vw - 32px)); }
.bmove form { display: flex; flex-direction: column; max-height: calc(100dvh - 48px); }
.dialog-body { overflow-y: auto; }
.sub { margin-top: 4px; font-size: var(--t-sm); }
.effects { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.effects li { display: flex; align-items: flex-start; gap: 10px; font-size: var(--t-sm); color: var(--ink-2); line-height: 1.45; }
.effects svg, .effects .spinner { flex: none; margin-top: 1px; color: var(--ink-3); }
/* what landing there does reads first, in ink; an email can't be unsent, so it alone is red */
.effects li.loud { padding: 10px 12px; border-radius: var(--r-field); background: var(--sunk); color: var(--ink); font-weight: 500; }
.effects li.loud svg { color: var(--ink-2); }
.effects li.final { background: var(--bad-tint); }
.effects li.final svg { color: var(--bad); }
/* the team's reasons, as the mock: one tap target per line, the picked one on the accent tint */
.opts { display: grid; gap: 4px; }
.opt { align-items: center; padding: 9px 12px; border-radius: var(--r-field); box-shadow: inset 0 0 0 1px var(--line); font-size: var(--t-md); }
.opt:hover { background: var(--hover); }
.opt:has(:checked) { background: var(--accent-tint); box-shadow: inset 0 0 0 1px var(--accent-line); }
.opt:has(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.opt input { margin-top: 0; }
.notify { align-items: flex-start; font-size: var(--t-md); }
.notify input { margin-top: 3px; }
.notify .faint { font-size: var(--t-sm); }
.dialog-foot { border-top: 1px solid var(--line); }
.dialog-foot .form-error { flex-basis: 100%; }
.issues { margin: 6px 0 0; padding-left: 1.1em; font-weight: 400; }
.moving { flex-basis: 100%; display: flex; align-items: center; gap: 8px; font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; }
</style>
