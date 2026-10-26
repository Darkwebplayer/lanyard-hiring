<script setup lang="ts">
import { rejectionEmailNode, rejectionSubject } from '~~/shared/workflow/graph'
import { arrivalEffects, relation } from '~~/shared/workflow/stages'
import type { FormField } from '~~/shared/workflow/types'
import type { Pos } from './NextMenu.vue'
import { type Timeline, stepName } from './Trace.vue'

// "Move to…" / "Reopen…" / a named next move: one dialog. A reason is needed only off the flow's own path;
// rejecting takes a reason from Settings; the target stage may ask questions; "This will:" says what lands.
const props = defineProps<{ tl: Timeline }>()
const emit = defineEmits<{ moved: [to: { node: string } | { close: string }] }>()
const dlg = ref<HTMLDialogElement>()
const choice = ref('')
const picking = ref(true) // false when opened on a named move: the list stays out of the way
const reason = ref('')
const reasonCode = ref('')
const answers = ref<Record<string, any>>({})
const notify = ref(false) // closing as rejected: off by default, they may have been told already
const busy = ref(false)
const err = ref('')
const issues = ref<string[]>([])

const ERR: Record<string, string> = {
  reason_code_required: 'Pick a reason for rejecting.',
  unknown_reason_code: 'That reason was taken off the list in Settings. Pick another.',
  invalid_answers: 'Some answers need another look.',
}

const closed = computed(() => props.tl.application.status === 'closed')
const graph = computed(() => props.tl.graph)
const first = computed(() => props.tl.candidate.firstName)
// Start and End aren't places to stand: "Close as …" covers the ends.
const steps = computed(() => props.tl.nodes.filter(n => n.type !== 'application_received' && n.type !== 'end' && n.type !== 'condition'))
const CLOSES = ['hired', 'rejected', 'withdrawn'] as const

const target = computed<Pos | null>(() => {
  const [kind, v = ''] = choice.value.split(':')
  if (!v) return null
  return kind === 'close' ? { closed: v as typeof CLOSES[number] } : { node: v }
})
const closingRejected = computed(() => !!target.value && 'closed' in target.value && target.value.closed === 'rejected')
const at = computed(() => closed.value || !props.tl.application.currentNodeKey ? null : { node: props.tl.application.currentNodeKey })
const isNext = computed(() => !!graph.value && !!at.value && !!target.value && relation(graph.value, at.value, target.value).kind === 'next')
const needReason = computed(() => !closingRejected.value && !isNext.value)
const effects = computed(() => graph.value && target.value
  ? arrivalEffects(graph.value, target.value).map(e => notify.value && closingRejected.value ? { ...e, text: e.text.replace('No email is sent.', 'They’re emailed the rejection.') } : e)
  : [])
// closing as rejected, or a step whose path ends in a rejection ("Otherwise → Rejection email"): ask the team's reason
const rejecting = computed(() => effects.value.some(e => e.outcome === 'rejected'))
// what can't be taken back is red, as on the board: a rejection, or an email that can't be unsent
const final = computed(() => rejecting.value || effects.value.some(e => e.kind === 'email'))
const ask = computed<FormField[]>(() => {
  const t = target.value
  if (!t || !('node' in t)) return []
  return (graph.value?.stages?.find(s => s.nodeKeys.includes(t.node))?.ask ?? []).filter(f => f.type !== 'file')
})

const settings = ref<{ rejectReasons: string[] } | null>(null)
const settingsErr = ref('')
watch(rejecting, async (r) => {
  if (!r || settings.value) return
  try {
    settings.value = await api('/api/settings')
    settingsErr.value = ''
    // opened on a rejecting move: the reason is the one thing left to give, so it gets focus once it's in
    if (!picking.value && dlg.value?.open) nextTick(() => dlg.value?.querySelector<HTMLElement>('input[name=move-code]')?.focus())
  }
  catch (e) { settingsErr.value = toApiError(e).message }
})
const fresh = () => { answers.value = Object.fromEntries(ask.value.map(f => [f.key, f.type === 'boolean' ? false : ''])) }
watch(ask, fresh)

const posName = (p: Pos) => 'node' in p ? stepName(props.tl, p.node) : p.closed
const title = computed(() => {
  const t = target.value
  if (!t || picking.value) return `${closed.value ? 'Reopen' : 'Move'} ${first.value}`
  if (rejecting.value) return `Reject ${first.value}?`
  if ('closed' in t) return `Close ${first.value} as ${t.closed}?`
  return `${closed.value ? 'Reopen' : 'Move'} ${first.value} ${closed.value ? 'at' : 'to'} ${posName(t)}?`
})
const label = computed(() => {
  const t = target.value
  if (!t) return closed.value ? 'Reopen' : 'Move'
  if (rejecting.value) return `Reject${effects.value.some(e => e.kind === 'email') ? ' and email' : ''} ${first.value}`
  if ('closed' in t) return `Close as ${t.closed}`
  return `${closed.value ? 'Reopen at' : 'Move to'} ${posName(t)}`
})

function open(preset?: Pos | null) {
  choice.value = preset ? ('node' in preset ? `node:${preset.node}` : `close:${preset.closed}`) : ''
  picking.value = !preset
  reason.value = ''
  reasonCode.value = ''
  notify.value = false
  fresh()
  err.value = ''
  issues.value = []
  dlg.value!.showModal()
  // straight to what's still missing; with nothing to fill in, the button
  if (preset) nextTick(() => dlg.value?.querySelector<HTMLElement>('[data-first], textarea[required], .dialog-foot .btn:last-child')?.focus())
}
defineExpose({ open })

// "key: Required" from the server → "Start date: Required"
const issueText = (m: string) => {
  const [k, ...rest] = m.split(': ')
  const f = ask.value.find(x => x.key === k)
  return f ? `${f.label}: ${rest.join(': ')}` : m
}
function cleanAnswers() {
  return Object.fromEntries(ask.value.flatMap((f) => {
    const v = answers.value[f.key]
    if (f.type === 'boolean') return [[f.key, !!v]]
    if (f.type === 'list') return listItems(v).length ? [[f.key, listItems(v)]] : []
    if (v === '' || v == null) return []
    if (f.type === 'number') return [[f.key, Number(v)]]
    return [[f.key, v]]
  }))
}

async function submit() {
  const t = target.value
  if (!t) return
  const to = 'closed' in t ? { close: t.closed } : { node: t.node }
  busy.value = true
  err.value = ''
  issues.value = []
  try {
    await api(`/api/applications/${props.tl.application.id}/move`, {
      method: 'POST',
      body: {
        to,
        ...(reason.value.trim() && { reason: reason.value.trim() }),
        ...(rejecting.value && reasonCode.value && { reasonCode: reasonCode.value }),
        ...(ask.value.length && { answers: cleanAnswers() }),
        ...(closingRejected.value && notify.value && { notify: true }),
      },
    })
    dlg.value!.close()
    emit('moved', to)
  }
  catch (e) {
    const x = toApiError(e)
    err.value = ERR[x.code] ?? x.message
    issues.value = x.issues.map(i => issueText(i.message))
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dlg" class="dialog move" :class="{ picking }" aria-labelledby="move-h" @click="e => e.target === dlg && dlg!.close()">
    <form @submit.prevent="submit">
      <div class="dialog-body">
        <div>
          <h2 id="move-h">{{ title }}</h2>
          <p v-if="picking" class="muted sub">{{ closed ? 'The workflow starts again from the step you pick.' : 'Whatever is in progress now is skipped, and the workflow carries on from the step you pick.' }}</p>
          <p v-else-if="!closed && tl.application.currentNodeKey" class="muted sub">
            From {{ stepName(tl, tl.application.currentNodeKey) }}.
            <button type="button" class="linkish" @click="picking = true">Pick another step</button>
          </p>
        </div>
        <template v-if="picking">
          <fieldset>
            <legend class="legend">{{ closed ? 'Reopen at' : 'Move to' }}</legend>
            <div class="opts">
              <label v-for="n in steps" :key="n.key" class="opt">
                <input v-model="choice" type="radio" name="move-to" :value="`node:${n.key}`" required>
                <Icon :name="nodeMeta(n.type).icon" :size="16" class="ico" />
                <span class="nm">{{ stepName(tl, n.key) }}</span>
                <span v-if="nodeMeta(n.type).noun !== stepName(tl, n.key)" class="faint">{{ nodeMeta(n.type).noun }}</span>
                <span v-if="n.key === tl.application.currentNodeKey" class="chip chip-accent now">{{ closed ? 'Ended here' : 'Now' }}</span>
              </label>
            </div>
          </fieldset>
          <fieldset v-if="!closed">
            <legend class="legend">Close application</legend>
            <div class="opts">
              <label v-for="c in CLOSES" :key="c" class="opt">
                <input v-model="choice" type="radio" name="move-to" :value="`close:${c}`">
                <Icon :name="c === 'hired' ? 'hires' : 'flag'" :size="16" class="ico" />
                <span class="nm">Close as {{ c }}</span>
              </label>
            </div>
          </fieldset>
        </template>

        <div v-if="effects.length" class="does" aria-live="polite">
          <p class="legend">This will:</p>
          <ul>
            <li v-for="(e, i) in effects" :key="i" :class="e.kind">
              <Icon :name="e.kind === 'email' ? 'mail' : e.kind === 'close' ? 'flag' : e.kind === 'booking' ? 'calendar' : e.kind === 'assign' ? 'person' : 'move'" :size="16" />{{ e.text }}
            </li>
          </ul>
        </div>

        <!-- the same radio rows as the board and list: one tap per reason, all of them visible -->
        <fieldset v-if="rejecting" class="field">
          <legend class="legend">Rejection reason</legend>
          <p v-if="settingsErr" class="error" role="alert"><Icon name="alert" :size="16" />{{ settingsErr }}</p>
          <div v-else-if="!settings" class="faint"><span class="spinner" /></div>
          <div v-else class="reasons">
            <label v-for="(r, i) in settings.rejectReasons" :key="r" class="reason check">
              <input v-model="reasonCode" type="radio" name="move-code" :value="r" required :data-first="i === 0 || undefined">{{ r }}
            </label>
          </div>
        </fieldset>

        <label v-if="closingRejected" class="check notify">
          <input v-model="notify" type="checkbox">
          <span>Send {{ first }} the rejection email<br><span class="faint">{{ graph && rejectionEmailNode(graph) ? 'The one from this job’s flow' : 'A short, polite note' }}: “{{ rejectionSubject(graph, tl.job.title) }}”. It shows on their page.</span></span>
        </label>

        <fieldset v-if="ask.length" class="ask">
          <legend class="legend">Stage questions</legend>
          <div v-for="(f, i) in ask" :key="f.key" class="field">
            <label v-if="f.type === 'boolean'" class="check">
              <input v-model="answers[f.key]" type="checkbox" :data-first="i === 0 || undefined">{{ f.label }}
            </label>
            <template v-else>
              <label :for="`ask-${f.key}`">{{ f.label }}<span v-if="!f.required" class="faint"> (optional)</span></label>
              <textarea v-if="f.type === 'text'" :id="`ask-${f.key}`" v-model="answers[f.key]" :required="f.required" rows="2" :data-first="i === 0 || undefined" />
              <select v-else-if="f.type === 'enum'" :id="`ask-${f.key}`" v-model="answers[f.key]" :required="f.required" :data-first="i === 0 || undefined">
                <option value="" :disabled="f.required">Pick one</option>
                <option v-for="o in f.options ?? []" :key="o" :value="o">{{ o }}</option>
              </select>
              <ListInput v-else-if="f.type === 'list'" v-model="answers[f.key]" :id="`ask-${f.key}`" :label="f.label" :max="f.max" :required="f.required" />
              <input
                v-else :id="`ask-${f.key}`" v-model="answers[f.key]" :required="f.required" :data-first="i === 0 || undefined"
                :type="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'" :min="f.type === 'number' ? f.min : undefined" :max="f.type === 'number' ? f.max : undefined"
              >
            </template>
          </div>
        </fieldset>

        <div class="field">
          <label for="move-reason">{{ needReason ? 'Reason' : 'Note' }}<span v-if="!needReason" class="faint"> (optional)</span></label>
          <textarea id="move-reason" v-model="reason" :required="needReason" maxlength="1000" rows="2" :placeholder="rejecting ? 'e.g. Can’t do weekend shifts' : needReason ? 'e.g. Owner wants to meet them this week' : 'e.g. Spoke on the phone, keen to start'" />
          <span class="hint">{{ rejecting ? 'Only your team sees it, in the candidate’s history.' : needReason && target ? 'This skips the workflow’s own path, so say why. Kept in the history with your name.' : 'Follows the workflow, so no reason needed.' }}</span>
        </div>
      </div>
      <div class="dialog-foot">
        <!-- here, not in the scrolling body, so the error is always in view next to the button that caused it -->
        <div v-if="err" class="form-error" role="alert">
          <Icon name="alert" :size="16" />
          <div>{{ err }}<ul v-if="issues.length" class="issues"><li v-for="m in issues" :key="m">{{ m }}</li></ul></div>
        </div>
        <button type="button" class="btn" @click="dlg!.close()">Cancel</button>
        <button class="btn" :class="final ? 'btn-danger' : 'btn-primary'" :disabled="busy || !target" :aria-busy="busy">
          <span v-if="busy" class="spinner" />{{ label }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.move { width: min(520px, calc(100vw - 32px)); }
.move form { display: flex; flex-direction: column; max-height: calc(100dvh - 48px); }
.dialog-body { overflow-y: auto; }
/* picking a step grows "This will:" and the questions under the list; a set height keeps the dialog,
   and so the Move button, still while the body scrolls inside it */
.picking form { height: min(720px, calc(100dvh - 48px)); }
.picking .dialog-body { flex: 1; align-content: start; }
.sub { margin-top: 4px; font-size: var(--t-sm); }
.linkish { border: 0; padding: 0; background: none; font: inherit; color: var(--accent-ink); font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
fieldset { display: grid; gap: 6px; }
.opts { display: grid; border: 1px solid var(--line); border-radius: var(--r-panel); overflow: hidden; }
.opt { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 12px; cursor: pointer; border-top: 1px solid var(--line); }
.opt:first-child { border-top: 0; }
.opt:hover { background: var(--hover); }
.opt:has(:checked) { background: var(--accent-tint); }
.ico { color: var(--ink-2); flex: none; }
.nm { font-weight: 600; min-width: 0; }
.faint { font-size: var(--t-sm); }
.now { margin-left: auto; }
/* what lands reads first, in ink, the same as the board's move dialog; an email can't be unsent, so it alone is red */
.does { display: grid; gap: 6px; }
.does ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.does li { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--r-field); background: var(--sunk); font-size: var(--t-sm); font-weight: 500; line-height: 1.45; }
.does li svg { flex: none; margin-top: 1px; color: var(--ink-2); }
.does li.email { background: var(--bad-tint); }
.does li.email svg { color: var(--bad); }
.ask { gap: 12px; }
.check { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: var(--t-sm); cursor: pointer; }
.notify { align-items: flex-start; }
.notify input { margin-top: 2px; }
/* the team's reasons, drawn as the board's move dialog draws them: the picked one on the accent tint */
.reasons { display: grid; gap: 4px; }
.reason { padding: 9px 12px; border-radius: var(--r-field); box-shadow: inset 0 0 0 1px var(--line); font-size: var(--t-md); font-weight: 400; }
.reason:hover { background: var(--hover); }
.reason:has(:checked) { background: var(--accent-tint); box-shadow: inset 0 0 0 1px var(--accent-line); }
.reason:has(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.issues { margin: 4px 0 0; padding-left: 18px; font-weight: 400; }
.dialog-foot { border-top: 1px solid var(--line); }
.dialog-foot .form-error { flex-basis: 100%; }
</style>
