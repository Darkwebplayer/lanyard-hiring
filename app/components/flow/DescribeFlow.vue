<script setup lang="ts">
// "How do you hire?": the person writes the flow in words and the server drafts the steps.
// inline: on an empty canvas, with ways to start without words. dialog: inside a <dialog>, over a flow that has steps.
const props = defineProps<{ mode: 'inline' | 'dialog', isJob: boolean, busy: boolean, error: string | null, replacing: string | null, canPreset: boolean }>()
const emit = defineEmits<{ draft: [], stop: [], preset: [], close: [] }>()
const text = defineModel<string>({ required: true })
const uid = useId()

// Each example is a whole description in a manager's words, so it shows what to write and stays editable.
const EXAMPLES = [
  { label: 'Café or shop staff', text: 'Quick phone call with me first. Then a paid two-hour trial shift on a Saturday morning. If the trial goes well, send the offer. Turn away anyone who can’t work weekends.' },
  { label: 'Warehouse shifts', text: 'Turn away anyone who can’t work early shifts. A team lead calls each person for 15 minutes. Then a site visit with a short safety walk. If the team lead says yes, send the offer. If not, send a polite no.' },
  { label: 'Office role with 2 interviews', text: 'Read the CV and score it against the job. I shortlist the best ones. First interview with me, then a second interview with two people from the team who each fill in a scorecard. Offer if both interviews go well, else a kind rejection email.' },
  { label: 'Trade apprentice', text: 'I read each application and pick who to meet. They spend a workshop day with a senior tradesperson, who says if they are a good fit. Then the offer, or a kind rejection email. No experience needed.' },
]
const box = ref<HTMLTextAreaElement>()
function fill(t: string) {
  text.value = t
  box.value?.focus()
}
const ready = computed(() => text.value.trim().length > 0 && !props.busy)
</script>

<template>
  <form class="describe" :class="mode" :aria-labelledby="`${uid}-h`" @submit.prevent="ready && emit('draft')">
    <h2 :id="`${uid}-h`">{{ isJob ? 'How do you hire for this job?' : 'How do you hire with this workflow?' }}</h2>
    <p class="muted">Write it the way you would tell a new manager. We draft the steps, and you check them before you save.</p>
    <label :for="`${uid}-t`" class="sr-only">How you hire</label>
    <textarea
      :id="`${uid}-t`" ref="box" v-model="text" maxlength="2000" rows="4" :readonly="busy"
      placeholder="Café barista: quick call, one paid trial shift, then offer."
      @keydown.meta.enter.prevent="ready && emit('draft')" @keydown.ctrl.enter.prevent="ready && emit('draft')"
    />
    <p v-if="replacing" class="reach">{{ replacing }}</p>
    <p v-if="error" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ error }}</p>
    <div class="row">
      <button class="btn btn-primary" :disabled="!ready && !busy" :aria-busy="busy" :aria-disabled="busy || undefined">
        <span v-if="busy" class="spinner" />{{ busy ? 'Drafting…' : 'Draft the flow' }}
      </button>
      <button v-if="busy" type="button" class="btn btn-quiet" @click="emit('stop')">Stop</button>
      <span class="faint note">Usually about half a minute.</span>
    </div>
    <div class="or" aria-hidden="true">Or start from an example</div>
    <div class="examples" role="group" aria-label="Fill in an example">
      <button v-for="x in EXAMPLES" :key="x.label" type="button" :disabled="busy" @click="fill(x.text)">{{ x.label }}</button>
    </div>
    <div class="foot">
      <template v-if="mode === 'inline'">
        <button v-if="canPreset" type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="emit('preset')"><Icon name="library" />Use a template</button>
        <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="emit('close')">Start empty</button>
      </template>
      <button v-else type="button" class="btn btn-sm btn-quiet push" @click="emit('close')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.describe { display: grid; gap: 14px; }
.describe.inline { width: min(560px, 100%); padding: 30px 28px 20px; }
.describe.dialog { padding: 28px 24px 18px; }
h2 { font-size: var(--t-xl); letter-spacing: -0.01em; color: var(--ink); text-wrap: balance; }
.muted { text-wrap: pretty; }
textarea { min-height: 112px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.note { font-size: var(--t-sm); }
.reach { padding: 10px 12px; border-radius: var(--r-field); background: var(--warn-tint); color: var(--ink); font-size: var(--t-sm); text-wrap: pretty; }
/* a rule that runs out from the words, so the examples read as a second way in */
.or { display: flex; align-items: center; gap: 10px; color: var(--ink-3); font-size: var(--t-sm); }
.or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.examples { display: flex; flex-wrap: wrap; gap: 6px; }
.examples button {
  height: 28px; padding: 0 12px; border: 0; border-radius: var(--r-pill); background: var(--sunk);
  font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); cursor: pointer;
}
.examples button:hover:not(:disabled) { background: var(--hover); color: var(--ink); }
.examples button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.examples button:disabled { cursor: not-allowed; opacity: 0.45; }
.foot { display: flex; gap: 4px; padding-top: 10px; border-top: 1px solid var(--line); margin-inline: -8px; }
.push { margin-left: auto; }
</style>
