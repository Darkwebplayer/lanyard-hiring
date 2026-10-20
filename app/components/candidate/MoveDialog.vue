<script setup lang="ts">
import { type Timeline, stepName } from './Trace.vue'

// "Move to…" / "Reopen…": pick a step of this candidate's flow version, or close; a reason is required.
const props = defineProps<{ tl: Timeline }>()
const emit = defineEmits<{ moved: [to: { node: string } | { close: string }] }>()
const dlg = ref<HTMLDialogElement>()
const choice = ref('')
const reason = ref('')
const busy = ref(false)
const err = ref('')

const closed = computed(() => props.tl.application.status === 'closed')
// Start and End aren't places to stand: "Close as …" covers the ends.
const steps = computed(() => props.tl.nodes.filter(n => n.type !== 'application_received' && n.type !== 'end'))
const CLOSES = ['hired', 'rejected', 'withdrawn']
const label = computed(() => {
  const [kind, v = ''] = choice.value.split(':')
  if (!v) return closed.value ? 'Reopen' : 'Move'
  if (kind === 'close') return `Close as ${v}`
  return `${closed.value ? 'Reopen at' : 'Move to'} ${stepName(props.tl, v)}`
})

function open() {
  choice.value = ''
  reason.value = ''
  err.value = ''
  dlg.value!.showModal()
}
defineExpose({ open })

async function submit() {
  const [kind, v = ''] = choice.value.split(':')
  const to = kind === 'close' ? { close: v } : { node: v }
  busy.value = true
  err.value = ''
  try {
    await api(`/api/applications/${props.tl.application.id}/move`, { method: 'POST', body: { to, reason: reason.value.trim() } })
    dlg.value!.close()
    emit('moved', to)
  }
  catch (e) {
    err.value = (e as ApiError).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dlg" class="dialog move" aria-labelledby="move-h" @click="e => e.target === dlg && dlg!.close()">
    <form @submit.prevent="submit">
      <div class="dialog-body">
        <div>
          <h2 id="move-h">{{ closed ? 'Reopen' : 'Move' }} {{ tl.candidate.firstName }}</h2>
          <p class="muted sub">{{ closed ? 'The flow starts again from the step you pick.' : 'Whatever is in progress now is skipped, and the flow carries on from the step you pick.' }}</p>
        </div>
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
          <legend class="legend">Or close it</legend>
          <div class="opts">
            <label v-for="c in CLOSES" :key="c" class="opt">
              <input v-model="choice" type="radio" name="move-to" :value="`close:${c}`">
              <Icon :name="c === 'hired' ? 'hires' : 'flag'" :size="16" class="ico" />
              <span class="nm">Close as {{ c }}</span>
            </label>
          </div>
        </fieldset>
        <div class="field">
          <label for="move-reason">Reason</label>
          <textarea id="move-reason" v-model="reason" required maxlength="1000" rows="2" />
          <span class="hint">Kept in the history with your name.</span>
        </div>
      </div>
      <div class="dialog-foot">
        <!-- here, not in the scrolling body, so the error is always in view next to the button that caused it -->
        <p v-if="err" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ err }}</p>
        <button type="button" class="btn" @click="dlg!.close()">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" :aria-busy="busy">
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
.sub { margin-top: 4px; font-size: var(--t-sm); }
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
.dialog-foot { border-top: 1px solid var(--line); }
.dialog-foot .form-error { flex-basis: 100%; }
</style>
