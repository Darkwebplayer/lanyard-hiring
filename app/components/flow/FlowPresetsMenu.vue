<script setup lang="ts">
import { namedPeople, withoutNamedPeople } from '~~/shared/workflow/flowPresets'
import { STANDARD_HIRE } from '~~/shared/workflow/templates'
import type { FormField, Graph } from '~~/shared/workflow/types'

type Flow = { form: FormField[], workflow: Graph }
const props = defineProps<{
  // the editor's current form and flow, with any pending save sent first
  source: () => Promise<Flow>
  form: FormField[]
  workflow: Graph
  liveVersion: number | null
  // archived jobs: their flow can still be reused, but nothing may replace it
  saveOnly?: boolean
}>()
const emit = defineEmits<{ replace: [next: Flow, name: string] }>()
const toast = useToast()
const { flowPresets, error, refresh, create, update } = useFlowPresets()

const menu = ref<HTMLElement>()
const steps = (g: Graph) => g.nodes.filter(n => n.type !== 'application_received').length
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const counts = (f: Flow) => `${plural(steps(f.workflow), 'step')} · ${plural(f.form.length, 'field')}`

// ---------- start from a preset ----------
const loadDlg = ref<HTMLDialogElement>()
const pick = ref('') // a question, not a setting: nothing replaces the draft by accident
const choices = computed(() => [
  { id: 'standard', name: 'Standard hire', counts: counts(STANDARD_HIRE), hint: 'Built in. CV read, AI review, shortlist, interview, offer.', flow: STANDARD_HIRE as Flow },
  ...(flowPresets.value ?? []).map(p => ({ id: p.id, name: p.name, counts: counts(p), hint: p.description, flow: p as Flow })),
])
function openLoad() {
  menu.value?.hidePopover()
  if (!flowPresets.value) refresh()
  pick.value = ''
  loadDlg.value?.showModal()
}
// the empty canvas's "Use a preset" opens this same picker
defineExpose({ openLoad })
function load() {
  const c = choices.value.find(x => x.id === pick.value)
  if (!c) return
  loadDlg.value?.close()
  emit('replace', clone({ form: c.flow.form, workflow: c.flow.workflow }), c.name)
}

// ---------- save as a preset ----------
const saveDlg = ref<HTMLDialogElement>()
const draft = reactive({ mode: 'new' as 'new' | 'replace', name: '', description: '', target: '', swap: true })
const saving = ref(false)
const saveError = ref<string | null>(null)
const named = computed(() => namedPeople(props.workflow).map(nodeLabel))
const target = computed(() => flowPresets.value?.find(p => p.id === draft.target))
function openSave() {
  menu.value?.hidePopover()
  if (!flowPresets.value) refresh()
  Object.assign(draft, { mode: 'new', name: '', description: '', target: flowPresets.value?.[0]?.id ?? '', swap: true })
  saveError.value = null
  saveDlg.value?.showModal()
}
// replacing keeps the preset's description unless you change it; a new preset starts blank
watch(() => [draft.mode, draft.target], () => { draft.description = draft.mode === 'replace' ? target.value?.description ?? '' : '' })
watch(flowPresets, (l) => { if (!draft.target && l?.length) draft.target = l[0]!.id })

async function save() {
  if (saving.value) return
  saving.value = true
  saveError.value = null
  try {
    const src = await props.source()
    const flow = { form: src.form, workflow: draft.swap ? withoutNamedPeople(src.workflow) : src.workflow }
    const p = draft.mode === 'new'
      ? await create({ name: draft.name.trim(), description: draft.description.trim(), ...flow })
      : await update(draft.target, { description: draft.description.trim(), ...flow })
    saveDlg.value?.close()
    toast.show(draft.mode === 'new' ? `Saved “${p.name}” as a flow preset` : `Replaced “${p.name}”. Jobs that started from it keep their flows.`,
      { label: 'Open', run: () => navigateTo({ path: '/library/flows', query: { flow: p.id } }) }, 8000)
  }
  catch (e) { saveError.value = toApiError(e).message }
  finally { saving.value = false }
}
</script>

<template>
  <button v-if="saveOnly" type="button" class="btn btn-quiet btn-sm presets-btn" @click="openSave">
    <Icon name="library" />Save as flow preset…
  </button>
  <button v-else type="button" class="btn btn-quiet btn-sm presets-btn" popovertarget="flow-presets-menu">
    <Icon name="library" />Flow presets<Icon name="chevron-down" :size="14" />
  </button>
  <div v-if="!saveOnly" id="flow-presets-menu" ref="menu" popover class="menu presets-menu">
    <button type="button" @click="openLoad"><Icon name="reopen" :size="16" />Start from a preset…</button>
    <button type="button" @click="openSave"><Icon name="library" :size="16" />Save as flow preset…</button>
  </div>

  <dialog ref="loadDlg" class="dialog" aria-labelledby="load-h" @click.self="loadDlg?.close()">
    <form @submit.prevent="load">
      <div class="dialog-body">
        <h2 id="load-h">Start from a preset</h2>
        <fieldset class="field">
          <legend class="sr-only">Flow preset</legend>
          <div class="choices">
            <label v-for="c in choices" :key="c.id" class="check">
              <input v-model="pick" type="radio" name="load-preset" :value="c.id">
              <span><b>{{ c.name }} <span class="n">{{ c.counts }}</span></b><span v-if="c.hint" class="hint">{{ c.hint }}</span></span>
            </label>
          </div>
          <p v-if="!flowPresets && !error" class="hint"><span class="spinner" />Loading your flow presets…</p>
          <p v-else-if="error && !flowPresets" class="hint">Your flow presets didn’t load. <button type="button" class="linkish" @click="refresh">Try again</button></p>
        </fieldset>
        <p class="reach">
          Replaces this draft’s form ({{ plural(form.length, 'field') }}) and flow ({{ plural(steps(workflow), 'step') }}).
          <template v-if="liveVersion">The live version v{{ liveVersion }} keeps taking applications until you publish.</template>
          You can undo it right after.
        </p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn btn-quiet" @click="loadDlg?.close()">Cancel</button>
        <button class="btn btn-primary" :disabled="!pick">Replace draft</button>
      </div>
    </form>
  </dialog>

  <dialog ref="saveDlg" class="dialog" aria-labelledby="save-h" @click.self="saveDlg?.close()">
    <form @submit.prevent="save">
      <div class="dialog-body">
        <h2 id="save-h">Save as flow preset</h2>
        <div class="seg" role="radiogroup" aria-label="Save as">
          <label><input v-model="draft.mode" type="radio" name="save-mode" value="new"><span>New preset</span></label>
          <label><input v-model="draft.mode" type="radio" name="save-mode" value="replace" :disabled="!flowPresets?.length"><span>Replace an existing one</span></label>
        </div>
        <div v-if="draft.mode === 'new'" class="field">
          <label for="sp-name">Name</label>
          <input id="sp-name" v-model="draft.name" required maxlength="100" autocomplete="off" placeholder="e.g. Engineering loop">
        </div>
        <div v-else class="field">
          <label for="sp-target">Preset to replace</label>
          <select id="sp-target" v-model="draft.target" required>
            <option v-for="p in flowPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <span v-if="target" class="hint">Its {{ plural(steps(target.workflow), 'step') }} and {{ plural(target.form.length, 'field') }} become this flow’s {{ plural(steps(workflow), 'step') }} and {{ plural(form.length, 'field') }}.</span>
        </div>
        <div class="field">
          <label for="sp-desc">Description <span class="faint">(optional)</span></label>
          <input id="sp-desc" v-model="draft.description" maxlength="300" placeholder="When to use it, in a line">
        </div>
        <div v-if="named.length" class="field named">
          <label class="check">
            <input v-model="draft.swap" type="checkbox">
            <span><b>Swap named people for each job’s owner</b>
              <span class="hint">{{ named.length < 2 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` }} {{ named.length === 1 ? 'goes' : 'go' }} to named people, who may not fit the next job. Roles stay as they are.</span></span>
          </label>
        </div>
        <p class="hint">Saves the form too. Job details such as must-have skills stay with this job.</p>
        <p v-if="saveError" class="form-error" role="alert"><Icon name="alert" />{{ saveError }}</p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn btn-quiet" @click="saveDlg?.close()">Cancel</button>
        <button class="btn btn-primary" :disabled="saving" :aria-busy="saving"><span v-if="saving" class="spinner" />{{ draft.mode === 'new' ? 'Save preset' : 'Replace preset' }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.presets-btn { anchor-name: --flow-presets; }
.presets-menu { position-anchor: --flow-presets; inset: auto; top: anchor(bottom); left: anchor(left); margin-top: 8px; }
.dialog-body { display: grid; gap: 16px; }
fieldset.field { gap: 10px; }
/* many presets scroll inside the dialog, so Cancel and Replace stay in view */
.choices { display: grid; gap: 10px; max-height: min(320px, 40dvh); overflow-y: auto; padding: 2px; }
.check > span { display: grid; gap: 1px; min-width: 0; }
.check b { font-weight: 600; overflow-wrap: anywhere; }
.check .n { margin-left: 4px; font-weight: 400; font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.check .hint { font-size: var(--t-sm); color: var(--ink-2); }
.hint { display: flex; align-items: center; gap: 8px; }
.reach { padding: 10px 12px; border-radius: var(--r-field); background: var(--sunk); color: var(--ink-2); font-size: var(--t-sm); text-wrap: pretty; }
.named { padding: 10px 12px; border-radius: var(--r-field); background: var(--warn-tint); }
.linkish { border: 0; background: none; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
</style>
