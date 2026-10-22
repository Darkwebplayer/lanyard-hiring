<script lang="ts">
import type { Person, Pos, Row } from '~/lib/board'

// What was dropped where. `people` null = the whole group at `from` but `except` (people pulled out
// on their own), `seen` = how many the board showed.
export interface Drop { from: Pos, fromLabel: string, people: Person[] | null, except: string[], seen: number, to: Row | null }
</script>

<script setup lang="ts">
import type { Board } from '~/pages/jobs/[id].vue'
import { posId } from '~/lib/board'

type Moved = { id: string, currentNodeKey: string | null, status: 'active' | 'closed', outcome: string | null }
const props = defineProps<{ jobId: string, targets: (Row & { group: string })[], steps: Board['steps'] }>()
const emit = defineEmits<{ moved: [res: { kind: 'sync', moved: Moved[] } | { kind: 'queued', from: Pos, to: Pos, queued: number }] }>()

const dlg = ref<HTMLDialogElement>()
const drop = ref<Drop | null>(null)
const toId = ref('')
const reason = ref('')
const busy = ref(false)
const err = ref('')
// the server's count, at the moment of asking: some may have moved on since the board loaded
const check = ref<{ count: number, notInVersion: number } | null>(null)
const checking = ref(false)

const to = computed(() => props.targets.find(t => t.id === toId.value) ?? null)
const choices = computed(() => {
  const from = drop.value?.from
  if (!from) return []
  return props.targets.filter(t => t.id !== posId(from) && !('closed' in from && 'closed' in t.pos))
})
const groups = computed(() => [...new Set(choices.value.map(c => c.group))])

function open(d: Drop) {
  drop.value = d
  toId.value = d.to?.id ?? ''
  reason.value = ''
  err.value = ''
  check.value = null
  dlg.value!.showModal()
  // straight to what's still missing: the step if it wasn't dropped, else the reason
  nextTick(() => dlg.value?.querySelector<HTMLElement>(d.to ? '#bmove-reason' : '#bmove-to')?.focus())
}
defineExpose({ open })

const body = (extra: object = {}) => ({
  from: drop.value!.from,
  to: 'node' in to.value!.pos ? { node: to.value!.pos.node } : { close: to.value!.pos.closed },
  reason: reason.value.trim(),
  ...(drop.value!.people ? { ids: drop.value!.people.map(p => p.id) } : drop.value!.except.length ? { except: drop.value!.except } : {}),
  ...extra,
})
watch(toId, async () => {
  check.value = null
  if (!to.value || !drop.value) return
  checking.value = true
  try { check.value = await api(`/api/jobs/${props.jobId}/moves`, { method: 'POST', body: body({ dryRun: true }) }) }
  catch (e) { err.value = toApiError(e).message }
  finally { checking.value = false }
})

const n = computed(() => check.value?.count ?? drop.value?.seen ?? 0)
const who = computed(() => {
  const p = drop.value?.people
  if (p?.length === 1) return p[0]!.name
  return `${n.value.toLocaleString()} ${n.value === 1 ? 'person' : 'people'}`
})
const reopening = computed(() => !!drop.value && 'closed' in drop.value.from)
const title = computed(() => {
  if (!to.value) return `Move ${who.value}`
  if ('closed' in to.value.pos) return `Close ${who.value} as ${to.value.pos.closed}?`
  return `${reopening.value ? 'Reopen' : 'Move'} ${who.value} ${reopening.value ? 'at' : 'to'} ${to.value.label}?`
})
const action = computed(() => {
  if (!to.value) return 'Move'
  if ('closed' in to.value.pos) return `Close as ${to.value.pos.closed}`
  return `${reopening.value ? 'Reopen' : 'Move'}${effect.value?.final ? ' and email' : ''} ${who.value}`
})

// What landing on the step does, said before it happens. The step runs for real: emails go out.
const effect = computed(() => {
  const t = to.value
  if (!t) return null
  const each = n.value === 1 ? '' : ' for each of them'
  if ('closed' in t.pos) return { icon: 'flag', text: `Their current step stops and open tasks are taken back. No email is sent.`, loud: false, final: false }
  const step = props.steps.find(s => s.key === (t.pos as { node: string }).node)
  const name = step ? nodeLabel(step) : t.label
  switch (step?.type) {
    case 'send_email': return { icon: 'mail', text: `Sends the “${name}” email${n.value === 1 ? '' : ` to all ${n.value.toLocaleString()}`}. It can’t be unsent.`, loud: true, final: true }
    case 'ai_review': return { icon: 'ai', text: `Runs a new AI review${each}.`, loud: true, final: false }
    case 'cv_parse': return { icon: 'scan', text: `Reads the CV again${each}.`, loud: false, final: false }
    case 'human_task': return { icon: 'person', text: `Assigns a new “${name}” task${each}.`, loud: true, final: false }
    default: return { icon: 'move', text: 'The flow carries on from this step.', loud: false, final: false }
  }
})
const blocked = computed(() => !!check.value && check.value.count === 0)

async function submit() {
  if (!to.value || !drop.value) return
  busy.value = true
  err.value = ''
  try {
    const res = await api<{ moved?: Moved[], queued?: number }>(`/api/jobs/${props.jobId}/moves`, { method: 'POST', body: body() })
    dlg.value!.close()
    if (res.moved) emit('moved', { kind: 'sync', moved: res.moved })
    else emit('moved', { kind: 'queued', from: drop.value.from, to: to.value.pos, queued: res.queued ?? 0 })
  }
  catch (e) { err.value = toApiError(e).message }
  finally { busy.value = false }
}
</script>

<template>
  <dialog ref="dlg" class="dialog bmove" aria-labelledby="bmove-h" @click="e => e.target === dlg && dlg!.close()">
    <form v-if="drop" @submit.prevent="submit">
      <div class="dialog-body">
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
          <li v-if="effect" :class="{ loud: effect.loud, final: effect.final }"><Icon :name="effect.icon" :size="16" />{{ effect.text }}</li>
          <li v-if="!drop.people && !checking && check && check.count !== drop.seen"><Icon name="clock" :size="16" />{{ check.count > drop.seen ? `${(check.count - drop.seen).toLocaleString()} more arrived` : `${(drop.seen - check.count).toLocaleString()} moved on` }} since the board loaded. All {{ check.count.toLocaleString() }} there now will move.</li>
          <li v-if="check?.notInVersion"><Icon name="lock" :size="16" />{{ check.notInVersion.toLocaleString() }} are on an older version of the flow without {{ to.label }}. They stay where they are.</li>
          <li v-if="!drop.people && n > 1"><Icon name="move" :size="16" />Moves run in the background. The board updates as they land.</li>
          <li v-if="checking" class="faint"><span class="spinner" />Checking who can move…</li>
        </ul>

        <div class="field">
          <label for="bmove-reason">Reason</label>
          <textarea id="bmove-reason" v-model="reason" required maxlength="1000" rows="2" />
          <span class="hint">Kept in {{ n === 1 ? 'the candidate’s' : 'each candidate’s' }} history with your name.</span>
        </div>
      </div>
      <div class="dialog-foot">
        <p v-if="err" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ err }}</p>
        <p v-else-if="blocked" class="form-error" role="alert"><Icon name="alert" :size="16" />Nobody here can move there now.</p>
        <button type="button" class="btn" @click="dlg!.close()">Cancel</button>
        <button class="btn" :class="effect?.final ? 'btn-danger' : 'btn-primary'" :disabled="busy || checking || blocked || !to" :aria-busy="busy">
          <span v-if="busy" class="spinner" />{{ action }}
        </button>
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
.dialog-foot { border-top: 1px solid var(--line); }
.dialog-foot .form-error { flex-basis: 100%; }
</style>
