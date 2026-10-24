<script setup lang="ts">
import type { Timeline } from './Trace.vue'

// The offer: its state and link in the side column, and "Make offer…" as a dialog that ends on the letter.
// Email isn't wired, so the recruiter copies the link and sends it themselves.
const props = defineProps<{ tl: Timeline }>()
const emit = defineEmits<{ changed: [] }>()

interface Offer {
  id: string, url: string, status: 'sent' | 'accepted' | 'declined' | 'withdrawn', letter: string
  terms: { salary: string, start_date: string, location?: string }, expiresAt: string | null
  signedName: string | null, respondedAt: string | null, createdAt: string
}
interface Template { id: string | null, name: string, builtIn?: boolean }

const ERR: Record<string, string> = {
  expires_in_past: 'That expiry date has passed. Pick a later one.',
  template_not_found: 'That template was deleted. Pick another.',
  offer_not_open: 'This offer was already answered or withdrawn. The panel is up to date now.',
}
const msg = (e: unknown) => { const x = toApiError(e); return ERR[x.code] ?? x.message }

const first = computed(() => props.tl.candidate.firstName)
const offers = ref<Offer[] | null>(null)
const loadErr = ref('')
async function load() {
  try { offers.value = await api<Offer[]>(`/api/applications/${props.tl.application.id}/offers`); loadErr.value = '' }
  catch (e) { loadErr.value = msg(e) }
}
watch(() => props.tl.application.id, load, { immediate: true })

const current = computed(() => offers.value?.[0] ?? null)
const expired = (o: Offer) => o.status === 'sent' && !!o.expiresAt && Date.parse(o.expiresAt) <= Date.now()
const open = (o: Offer | null) => !!o && o.status === 'sent' && !expired(o)
const link = (o: Offer) => `${location.origin}${o.url}`
const STATE: Record<string, { text: string, chip: string }> = {
  sent: { text: 'Sent', chip: 'chip-accent' },
  accepted: { text: 'Accepted', chip: 'chip-ok' },
  declined: { text: 'Declined', chip: '' },
  withdrawn: { text: 'Withdrawn', chip: '' },
  expired: { text: 'Expired', chip: 'chip-warn' },
}
const stateOf = (o: Offer) => STATE[expired(o) ? 'expired' : o.status]!

// ---- copy ----
const copied = ref<boolean | 'failed'>(false)
let timer: ReturnType<typeof setTimeout> | undefined
async function copy(o: Offer) {
  copied.value = (await copyText(link(o))) || 'failed'
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), copied.value === 'failed' ? 4000 : 2000)
}

// ---- withdraw ----
const confirming = ref(false)
const withdrawing = ref(false)
const panelErr = ref('')
async function withdraw() {
  withdrawing.value = true
  panelErr.value = ''
  try {
    await api(`/api/offers/${current.value!.id}/withdraw`, { method: 'POST' })
    confirming.value = false
    await load()
    emit('changed')
  }
  catch (e) { panelErr.value = msg(e); await load() }
  finally { withdrawing.value = false }
}

// ---- make ----
const dlg = ref<HTMLDialogElement>()
const templates = ref<Template[] | null>(null)
const tplErr = ref('')
const form = reactive({ template: '', salary: '', start: '', location: '', expires: '' })
const busy = ref(false)
const err = ref('')
const made = ref<Offer | null>(null)
const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in the viewer's zone

async function openDialog() {
  made.value = null
  err.value = ''
  const last = current.value
  Object.assign(form, { template: '', salary: last?.terms.salary ?? '', start: last?.terms.start_date ?? '', location: last?.terms.location ?? '', expires: '' })
  dlg.value!.showModal()
  if (!templates.value) {
    try {
      templates.value = await api<Template[]>('/api/offer-templates')
      tplErr.value = ''
      if (!form.template && templates.value[0]?.id) form.template = templates.value[0].id // the company's own letter first
    }
    catch (e) { tplErr.value = msg(e) }
  }
}
defineExpose({ open: openDialog })

async function submit() {
  busy.value = true
  err.value = ''
  try {
    made.value = await api<Offer>(`/api/applications/${props.tl.application.id}/offers`, {
      method: 'POST',
      body: {
        templateId: form.template || null,
        terms: { salary: form.salary.trim(), start_date: form.start, ...(form.location.trim() && { location: form.location.trim() }) },
        // the end of the chosen day, where the recruiter is
        ...(form.expires && { expiresAt: new Date(`${form.expires}T23:59:59`).toISOString() }),
      },
    })
    await load()
    emit('changed')
    nextTick(() => dlg.value?.querySelector<HTMLElement>('#offer-copy')?.focus())
  }
  catch (e) { err.value = msg(e) }
  finally { busy.value = false }
}
</script>

<template>
  <section v-if="current || loadErr" class="panel offer" aria-labelledby="offer-h">
    <div class="ohead">
      <h2 id="offer-h" class="sec">Offer</h2>
      <span v-if="current" class="chip" :class="stateOf(current).chip">{{ stateOf(current).text }}</span>
    </div>
    <p v-if="loadErr" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ loadErr }}</p>
    <template v-else-if="current">
      <dl class="terms">
        <div><dt>Salary</dt><dd>{{ current.terms.salary }}</dd></div>
        <div><dt>Start date</dt><dd>{{ fmtDate(`${current.terms.start_date}T00:00`) }}</dd></div>
        <div v-if="current.terms.location"><dt>Location</dt><dd>{{ current.terms.location }}</dd></div>
      </dl>
      <p class="said">
        <template v-if="current.status === 'accepted'">Accepted {{ fmtDate(current.respondedAt) }}, signed “{{ current.signedName }}”</template>
        <template v-else-if="current.status === 'declined'">{{ first }} declined it {{ fmtDate(current.respondedAt) }}</template>
        <template v-else-if="current.status === 'withdrawn'">Withdrawn. The link no longer works.</template>
        <template v-else-if="expired(current)">Expired {{ fmtDate(current.expiresAt) }}. Make a new offer to send another link.</template>
        <template v-else>Made {{ fmtDate(current.createdAt) }}<template v-if="current.expiresAt">, open until {{ fmtDate(current.expiresAt) }}</template>. Send {{ first }} the link yourself.</template>
      </p>
      <div v-if="open(current)" class="copy">
        <a :href="link(current)" target="_blank" rel="noopener" class="url mono">{{ link(current).replace(/^https?:\/\//, '') }}</a>
        <button type="button" class="btn btn-sm" @click="copy(current)">
          <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'copy'" /><span aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Select it and copy' : 'Copy offer link' }}</span>
        </button>
      </div>
      <details class="letter-wrap">
        <summary>Read the letter</summary>
        <!-- renderMarkdown escapes everything first: safe to inject -->
        <div class="letter" v-html="renderMarkdown(current.letter, 3)" />
      </details>
      <div v-if="current.status === 'sent' && !expired(current)" class="withdraw">
        <template v-if="confirming">
          <p class="warn">The link stops working for {{ first }}. This can’t be undone; you can make a new offer after.</p>
          <div class="row">
            <button type="button" class="btn btn-sm btn-danger" :disabled="withdrawing" :aria-busy="withdrawing" @click="withdraw">
              <span v-if="withdrawing" class="spinner" />Withdraw offer
            </button>
            <button type="button" class="btn btn-sm btn-quiet" @click="confirming = false">Keep it</button>
          </div>
        </template>
        <button v-else type="button" class="btn btn-sm btn-quiet" @click="confirming = true">Withdraw…</button>
      </div>
      <p v-if="panelErr" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ panelErr }}</p>
    </template>
  </section>

  <dialog ref="dlg" class="dialog offer-dlg" aria-labelledby="offer-dlg-h" @click="e => e.target === dlg && dlg!.close()">
    <form v-if="!made" @submit.prevent="submit">
      <div class="dialog-body">
        <div>
          <h2 id="offer-dlg-h">Make {{ first }} an offer</h2>
          <p v-if="open(current)" class="muted sub">This replaces the offer made {{ fmtDate(current!.createdAt) }}. Its link stops working.</p>
        </div>
        <div class="field">
          <label for="offer-tpl">Letter</label>
          <select id="offer-tpl" v-model="form.template" :disabled="!templates">
            <option v-if="!templates" value="">Loading templates…</option>
            <template v-else>
              <option v-for="t in templates" :key="t.id ?? 'built-in'" :value="t.id ?? ''">{{ t.name }}{{ t.builtIn ? ' (built in)' : '' }}</option>
              <option v-if="!templates.some(t => t.builtIn)" value="">Standard offer (built in)</option>
            </template>
          </select>
          <span v-if="tplErr" class="error"><Icon name="alert" :size="16" />{{ tplErr }} The built-in letter still works.</span>
        </div>
        <div class="two">
          <div class="field">
            <label for="offer-salary">Salary</label>
            <input id="offer-salary" v-model="form.salary" required maxlength="100" placeholder="e.g. £42,000 a year">
          </div>
          <div class="field">
            <label for="offer-start">Start date</label>
            <input id="offer-start" v-model="form.start" type="date" required :min="today()">
          </div>
        </div>
        <div class="field">
          <label for="offer-loc">Location <span class="optional">optional</span></label>
          <input id="offer-loc" v-model="form.location" maxlength="200" placeholder="e.g. Leeds office, 3 days a week">
        </div>
        <div class="field">
          <label for="offer-exp">Open until <span class="optional">optional</span></label>
          <input id="offer-exp" v-model="form.expires" type="date" :min="today()">
          <span class="hint">After this day {{ first }} can’t accept. Leave it empty to keep the offer open.</span>
        </div>
      </div>
      <div class="dialog-foot">
        <p v-if="err" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ err }}</p>
        <button type="button" class="btn" @click="dlg!.close()">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" :aria-busy="busy"><span v-if="busy" class="spinner" />Make offer</button>
      </div>
    </form>
    <div v-else>
      <div class="dialog-body">
        <div>
          <h2 id="offer-dlg-h">Offer ready for {{ first }}</h2>
          <p class="muted sub">Nothing is emailed from here. Copy the link and send it to {{ first }} yourself; they accept by typing their name.</p>
        </div>
        <div class="letter sheet" v-html="renderMarkdown(made.letter, 3)" />
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="dlg!.close()">Done</button>
        <button id="offer-copy" type="button" class="btn btn-primary" @click="copy(made)">
          <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'copy'" /><span aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Copy failed: use the link in the side panel' : 'Copy offer link' }}</span>
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.offer { padding: 18px; display: grid; gap: 10px; }
.ohead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sec { font-size: var(--t-lg); margin: 0; }
.terms { margin: 0; display: grid; gap: 6px; }
.terms div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 8px; font-size: var(--t-sm); }
.terms dt { color: var(--ink-2); }
.terms dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.said { font-size: var(--t-sm); color: var(--ink-2); }
.copy { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 14px; border-radius: var(--r-pill); background: var(--sunk); }
.url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); color: var(--ink); text-decoration: none; }
.url:hover { text-decoration: underline; }
.copy .btn { flex: none; }
.letter-wrap summary { cursor: pointer; font-size: var(--t-sm); font-weight: 600; color: var(--accent-ink); width: fit-content; }
.letter-wrap .letter { margin-top: 8px; max-height: 320px; overflow-y: auto; padding: 12px 14px; border-radius: var(--r-field); background: var(--sunk); }
.letter { font-size: var(--t-sm); line-height: 1.55; overflow-wrap: anywhere; }
.letter :deep(p), .letter :deep(ul) { margin: 0 0 10px; }
.letter :deep(ul) { padding-left: 18px; }
.withdraw { display: grid; gap: 8px; }
.withdraw > .btn { justify-self: start; margin-left: -12px; }
.warn { font-size: var(--t-sm); }
.row { display: flex; gap: 8px; }

.offer-dlg { width: min(560px, calc(100vw - 32px)); }
.offer-dlg > form, .offer-dlg > div { display: flex; flex-direction: column; max-height: calc(100dvh - 48px); }
.dialog-body { overflow-y: auto; }
.sub { margin-top: 4px; font-size: var(--t-sm); }
.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.optional { font-weight: 400; color: var(--ink-3); }
/* the letter as the candidate will read it: a sheet, not a form */
.sheet { padding: 20px 24px; border-radius: var(--r-field); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); max-width: 65ch; }
.dialog-foot { border-top: 1px solid var(--line); }
.dialog-foot .form-error { flex-basis: 100%; }
</style>
