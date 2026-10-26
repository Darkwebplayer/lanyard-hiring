<script setup lang="ts">
import type { Timeline } from './Trace.vue'

// The offer card, "Make offer…" (emails the letter link) and "Record their answer…" (it came by phone, email or
// in person: the same effect as the link). `bare` renders only the dialogs, for the inbox's Make offer task.
const props = defineProps<{ tl: Timeline, bare?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

type Via = 'link' | 'phone' | 'email' | 'in_person'
interface Offer {
  id: string, url: string, status: 'sent' | 'accepted' | 'declined' | 'withdrawn', letter: string
  terms: { salary: string, start_date: string, location?: string }, expiresAt: string | null
  signedName: string | null, respondedAt: string | null, createdAt: string
  answer: { via: Via, reason?: string, note?: string, by?: { id: string, name: string } } | null
  emailed: { to: string, at: string } | null
  warning?: 'seats_full', openings?: number, hired?: number
}
interface Template { id: string | null, name: string, builtIn?: boolean }

const ERR: Record<string, string> = {
  expires_in_past: 'That expiry date has passed. Pick a later one.',
  template_not_found: 'That template was deleted. Pick another.',
  offer_not_open: 'This offer was already answered or withdrawn. The card is up to date now.',
}
const msg = (e: unknown) => { const x = toApiError(e); return ERR[x.code] ?? x.message }
const toast = useToast()

const first = computed(() => props.tl.candidate.firstName)
const offers = ref<Offer[] | null>(null)
const loadErr = ref('')
async function load() {
  try { offers.value = await api<Offer[]>(`/api/applications/${props.tl.application.id}/offers`); loadErr.value = '' }
  catch (e) { loadErr.value = msg(e) }
}
watch(() => props.tl, load, { immediate: true })

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
const VIA: Record<Via, string> = { link: 'on the link', phone: 'on the phone', email: 'by email', in_person: 'in person' }
// "2027-01-04" is a calendar day: built in local time so no zone moves it
const day = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y!, m! - 1, dd!).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) }
const termsLine = (o: Offer) => [o.terms.salary, `starts ${day(o.terms.start_date)}`, o.terms.location, o.expiresAt && `open until ${fmtDate(o.expiresAt)}`].filter(Boolean).join(' · ')
const headline = (o: Offer) => expired(o) ? 'The offer has expired.' : {
  sent: `Offer sent. Waiting for ${first.value}’s answer.`,
  accepted: `${first.value} accepted the offer.`,
  declined: `${first.value} declined the offer.`,
  withdrawn: 'The offer was withdrawn. The link no longer works.',
}[o.status]

// ---- copy, send again ----
const copied = ref<boolean | 'failed'>(false)
let timer: ReturnType<typeof setTimeout> | undefined
async function copy(o: Offer) {
  copied.value = (await copyText(link(o))) || 'failed'
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), copied.value === 'failed' ? 4000 : 2000)
}
const resending = ref(false)
const panelErr = ref('')
async function resend() {
  resending.value = true
  panelErr.value = ''
  try {
    await api(`/api/offers/${current.value!.id}/resend`, { method: 'POST' })
    toast.show(`Emailed the offer to ${first.value} again.`)
    emit('changed')
  }
  catch (e) { panelErr.value = msg(e); await load() }
  finally { resending.value = false }
}

// ---- withdraw ----
const confirming = ref(false)
const withdrawing = ref(false)
async function withdraw() {
  withdrawing.value = true
  panelErr.value = ''
  try {
    await api(`/api/offers/${current.value!.id}/withdraw`, { method: 'POST' })
    confirming.value = false
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
const seats = ref<{ openings: number, hired: number } | null>(null) // every opening already filled: say so, still allow it
const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in the viewer's zone
// the job's own pay and place. A range isn't a term, so only a single amount (or the currency) is filled in; the range is the hint.
const { detail: jobDetail, refresh: refreshJob } = useJob(props.tl.job.id)
const req = computed(() => jobDetail.value?.job.requirements)
const range = () => req.value ? salaryText({ min: req.value.salary_min ?? null, max: req.value.salary_max ?? null, currency: req.value.salary_currency ?? null }) : null
function pay() {
  const r = req.value
  if (!r) return ''
  const cur = r.salary_currency ? `${r.salary_currency} ` : ''
  return r.salary_min != null && r.salary_min === r.salary_max ? `${cur}${r.salary_min.toLocaleString('en')}` : cur
}
const salaryHint = computed(() => range() ? `Job range: ${range()}` : `e.g. ${req.value?.salary_currency ? `${req.value.salary_currency} ` : ''}4,800 a month`)
const placeHint = computed(() => `e.g. ${req.value?.location || 'Main office'}`)

async function openDialog() {
  made.value = null
  err.value = ''
  const last = current.value
  Object.assign(form, { template: '', salary: last?.terms.salary ?? pay(), start: last?.terms.start_date ?? '', location: last?.terms.location ?? '', expires: '' })
  dlg.value!.showModal()
  if (!jobDetail.value) refreshJob().then(() => { if (!last && !form.salary) form.salary = pay() })
  api<{ jobs: { id: string, openings: number, hired: number }[] }>('/api/reports/hires')
    .then((r) => { const j = r.jobs.find(x => x.id === props.tl.job.id); seats.value = j && j.hired >= j.openings ? j : null })
    .catch(() => {}) // the warning just doesn't show; the server says it again after
  if (!templates.value) {
    try {
      templates.value = await api<Template[]>('/api/offer-templates')
      tplErr.value = ''
      if (!form.template && templates.value[0]?.id) form.template = templates.value[0].id // the company's own letter first
    }
    catch (e) { tplErr.value = msg(e) }
  }
}

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
    emit('changed')
    nextTick(() => dlg.value?.querySelector<HTMLElement>('#offer-done')?.focus())
  }
  catch (e) { err.value = msg(e) }
  finally { busy.value = false }
}

// ---- record their answer ----
const ansDlg = ref<HTMLDialogElement>()
const ans = reactive({ accepted: true, via: 'phone' as Exclude<Via, 'link'>, note: '', reason: '', other: '', notify: true })
const ansBusy = ref(false)
const ansErr = ref('')
// an interview booked for later: accepting calls it off (the server does it; this only says so)
const booked = computed(() => {
  const ev = props.tl.events
  const b = ev.findLast(e => e.type === 'booked')
  if (!b || Date.parse(b.data?.startsAt) <= Date.now() || ev.some(e => e.type === 'booking_cancelled' && e.data?.runId === b.data?.runId)) return null
  const run = props.tl.runs.find(r => r.id === b.data?.runId)
  return { at: b.data.startsAt as string, who: run?.assignments.filter(a => !a.closedAt).map(a => a.name) ?? [] }
})
function openAnswer() {
  Object.assign(ans, { accepted: true, via: 'phone', note: '', reason: '', other: '', notify: true })
  ansErr.value = ''
  ansDlg.value!.showModal()
}
async function record() {
  ansBusy.value = true
  ansErr.value = ''
  const reason = ans.reason === 'Other' ? ans.other.trim() : ans.reason
  try {
    await api(`/api/offers/${current.value!.id}/answer`, {
      method: 'POST',
      body: { accepted: ans.accepted, via: ans.via, notify: ans.notify, ...(ans.note.trim() && { note: ans.note.trim() }), ...(!ans.accepted && reason && { reason }) },
    })
    ansDlg.value!.close()
    emit('changed')
  }
  catch (e) { ansErr.value = msg(e); await load() }
  finally { ansBusy.value = false }
}
defineExpose({ open: openDialog })
</script>

<template>
  <section v-if="!bare && (current || loadErr)" class="panel offer" aria-labelledby="offer-h">
    <div class="ohead">
      <h2 id="offer-h" class="eyebrow">Offer</h2>
      <span v-if="current" class="chip" :class="stateOf(current).chip">{{ stateOf(current).text }}</span>
    </div>
    <p v-if="loadErr" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ loadErr }}</p>
    <template v-else-if="current">
      <p class="headline">{{ headline(current) }}</p>
      <div class="facts">
        <p v-if="current.emailed">Emailed to {{ current.emailed.to }} on {{ fmtBooked(current.emailed.at) }}</p>
        <p>{{ termsLine(current) }}</p>
      </div>
      <p v-if="current.status === 'accepted' || current.status === 'declined'" class="said">
        <span class="chip" :class="current.status === 'accepted' ? 'chip-ok' : ''">{{ stateOf(current).text }}</span>
        <span>
          <template v-if="current.answer?.by">Recorded by {{ current.answer.by.name }}, {{ fmtDate(current.respondedAt) }}, {{ VIA[current.answer.via] }}</template>
          <template v-else-if="current.signedName">Signed on the link as “{{ current.signedName }}”, {{ fmtDate(current.respondedAt) }}</template>
          <template v-else>On the link, {{ fmtDate(current.respondedAt) }}</template>
          <template v-if="current.answer?.reason">. Reason: {{ current.answer.reason }}</template>
          <template v-if="current.answer?.note">: “{{ current.answer.note }}”</template>
        </span>
      </p>
      <p v-else-if="expired(current)" class="said">Make a new offer to send another link.</p>

      <template v-if="open(current)">
        <div v-if="!confirming" class="row">
          <button type="button" class="btn btn-primary" @click="openAnswer">Record their answer…</button>
          <button type="button" class="btn" @click="copy(current)">
            <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'copy'" /><span aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Copy failed' : 'Copy link' }}</span>
          </button>
          <button type="button" class="btn" :disabled="resending" :aria-busy="resending" @click="resend"><span v-if="resending" class="spinner" />Send again</button>
          <button type="button" class="btn btn-quiet danger-text" @click="confirming = true">Withdraw</button>
        </div>
        <div v-else class="withdraw">
          <p class="warn">The link stops working for {{ first }}. This can’t be undone; you can make a new offer after.</p>
          <div class="row">
            <button type="button" class="btn btn-sm btn-danger" :disabled="withdrawing" :aria-busy="withdrawing" @click="withdraw">
              <span v-if="withdrawing" class="spinner" />Withdraw offer
            </button>
            <button type="button" class="btn btn-sm btn-quiet" @click="confirming = false">Keep it</button>
          </div>
        </div>
        <p class="tip">Did {{ first }} answer on the phone or by email? Use <b>Record their answer</b>. It counts the same as clicking the link, and the confirmation email still goes.</p>
      </template>
      <details class="letter-wrap">
        <summary>View letter</summary>
        <!-- renderMarkdown escapes everything first: safe to inject -->
        <div class="letter" v-html="renderMarkdown(current.letter, 3)" />
      </details>
      <p v-if="panelErr" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ panelErr }}</p>
    </template>
  </section>

  <dialog ref="dlg" class="dialog offer-dlg" aria-labelledby="offer-dlg-h" @click="e => e.target === dlg && dlg!.close()">
    <form v-if="!made" @submit.prevent="submit">
      <div class="dialog-body">
        <div>
          <h2 id="offer-dlg-h">Make an offer to {{ first }}</h2>
          <p v-if="open(current)" class="muted sub">This replaces the offer made {{ fmtDate(current!.createdAt) }}. Its link stops working.</p>
        </div>
        <p v-if="seats" class="seats">This job has {{ plural(seats.openings, 'opening') }} and {{ plural(seats.hired, 'person is', 'people are') }} already hired. You can still make the offer.</p>
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
        <div class="field">
          <label for="offer-salary">Salary</label>
          <input id="offer-salary" v-model="form.salary" required maxlength="100" :placeholder="salaryHint">
          <span class="hint">As it should read in the letter, e.g. “SGD 4,800 a month”.</span>
        </div>
        <div class="two">
          <div class="field">
            <label for="offer-start">Start date</label>
            <input id="offer-start" v-model="form.start" type="date" required :min="today()">
          </div>
          <div class="field">
            <label for="offer-exp">Offer expires <span class="optional">optional</span></label>
            <input id="offer-exp" v-model="form.expires" type="date" :min="today()">
          </div>
        </div>
        <div class="field">
          <label for="offer-loc">Location <span class="optional">optional</span></label>
          <input id="offer-loc" v-model="form.location" maxlength="200" :placeholder="placeHint">
        </div>
        <p class="note">We email the letter link to <b>{{ tl.candidate.email }}</b> and keep a copy on {{ first }}’s page.</p>
      </div>
      <div class="dialog-foot">
        <p v-if="err" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ err }}</p>
        <button type="button" class="btn" @click="dlg!.close()">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" :aria-busy="busy"><span v-if="busy" class="spinner" />Send offer</button>
      </div>
    </form>
    <div v-else>
      <div class="dialog-body">
        <div>
          <h2 id="offer-dlg-h">Offer sent to {{ first }}</h2>
          <p class="muted sub">We emailed the letter link to {{ tl.candidate.email }}. {{ first }} accepts by typing their name, or you record their answer.</p>
        </div>
        <p v-if="made.warning === 'seats_full'" class="seats">Every opening for this job is already filled. The offer still went out.</p>
        <div class="letter sheet" v-html="renderMarkdown(made.letter, 3)" />
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="copy(made)">
          <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'copy'" /><span aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Copy failed' : 'Copy link' }}</span>
        </button>
        <button id="offer-done" type="button" class="btn btn-primary" @click="dlg!.close()">Done</button>
      </div>
    </div>
  </dialog>

  <dialog ref="ansDlg" class="dialog offer-dlg" aria-labelledby="ans-h" @click="e => e.target === ansDlg && ansDlg!.close()">
    <form @submit.prevent="record">
      <div class="dialog-body">
        <div>
          <h2 id="ans-h">Record {{ first }}’s response</h2>
          <p class="muted sub">For when {{ first }} answered on the phone, by email or in person.</p>
        </div>
        <div class="pick" role="group" aria-label="Their answer">
          <button type="button" class="btn" :aria-pressed="ans.accepted" @click="ans.accepted = true">{{ first }} accepted</button>
          <button type="button" class="btn" :aria-pressed="!ans.accepted" @click="ans.accepted = false">{{ first }} declined</button>
        </div>
        <div class="field">
          <label for="ans-via">Response received via</label>
          <select id="ans-via" v-model="ans.via">
            <option value="phone">On the phone</option>
            <option value="email">By email</option>
            <option value="in_person">In person</option>
          </select>
        </div>
        <div v-if="!ans.accepted" class="field">
          <label for="ans-reason">Why? <span class="optional">optional</span></label>
          <select id="ans-reason" v-model="ans.reason">
            <option value="">Didn’t say</option>
            <option v-for="r in DECLINE_REASONS" :key="r" :value="r">{{ r }}</option>
          </select>
          <input v-if="ans.reason === 'Other'" v-model="ans.other" maxlength="200" aria-label="Their reason" placeholder="In a few words">
        </div>
        <div class="field">
          <label for="ans-note">Note <span class="optional">optional</span></label>
          <textarea id="ans-note" v-model="ans.note" maxlength="1000" rows="2" placeholder="e.g. Told me on the phone" />
        </div>
        <label class="check confirm">
          <input v-model="ans.notify" type="checkbox">
          <span>Email {{ first }} to confirm<br><span class="optional">{{ ans.accepted ? '“Welcome to the team”, the same email as when they accept on the link' : 'A short thank-you, the same as when they decline on the link' }}</span></span>
        </label>
        <p class="note">
          <template v-if="ans.accepted">Marks {{ first }} as accepted, and the workflow moves them on.<template v-if="booked"> The interview booked for {{ fmtBooked(booked.at) }} is cancelled<template v-if="booked.who.length"> and {{ booked.who.join(' and ') }} see it in their inbox</template>.</template></template>
          <template v-else>Closes {{ first }} as withdrawn.</template>
        </p>
      </div>
      <div class="dialog-foot">
        <p v-if="ansErr" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ ansErr }}</p>
        <button type="button" class="btn" @click="ansDlg!.close()">Cancel</button>
        <button class="btn btn-primary" :disabled="ansBusy" :aria-busy="ansBusy"><span v-if="ansBusy" class="spinner" />{{ ans.accepted ? 'Mark accepted' : 'Mark declined' }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.offer { padding: 22px 24px; display: grid; gap: 12px; }
.ohead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.eyebrow { margin: 0; font-size: var(--t-xs); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
.headline { font-size: var(--t-xl); font-weight: 600; }
.facts { display: grid; gap: 4px; font-size: var(--t-sm); color: var(--ink-2); overflow-wrap: anywhere; }
.said { display: flex; align-items: baseline; gap: 10px; font-size: var(--t-sm); }
.said .chip { flex: none; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.danger-text { color: var(--bad); }
.tip { font-size: var(--t-sm); color: var(--ink-2); background: var(--sunk); border-radius: var(--r-field); padding: 10px 12px; }
.letter-wrap summary { cursor: pointer; font-size: var(--t-sm); font-weight: 600; color: var(--accent-ink); width: fit-content; }
.letter-wrap .letter { margin-top: 8px; max-height: 320px; overflow-y: auto; padding: 12px 14px; border-radius: var(--r-field); background: var(--sunk); }
.letter { font-size: var(--t-sm); line-height: 1.55; overflow-wrap: anywhere; }
.letter :deep(p), .letter :deep(ul) { margin: 0 0 10px; }
.letter :deep(ul) { padding-left: 18px; }
.withdraw { display: grid; gap: 8px; }
.warn { font-size: var(--t-sm); }

.offer-dlg { width: min(560px, calc(100vw - 32px)); }
.offer-dlg > form, .offer-dlg > div { display: flex; flex-direction: column; max-height: calc(100dvh - 48px); }
.dialog-body { overflow-y: auto; }
.sub { margin-top: 4px; font-size: var(--t-sm); }
.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.optional { font-weight: 400; color: var(--ink-3); }
.seats { background: var(--warn-tint); color: var(--warn); border-radius: var(--r-field); padding: 10px 12px; font-size: var(--t-sm); }
.note { font-size: var(--t-sm); color: var(--ink-2); border-top: 1px solid var(--line); padding-top: 12px; }
.pick { display: flex; gap: 8px; }
.pick .btn { flex: 1; min-height: 44px; }
.pick .btn[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--accent); background: var(--accent-tint); color: var(--accent-ink); font-weight: 600; }
.confirm { display: flex; gap: 10px; align-items: flex-start; font-weight: 500; }
.confirm input { margin-top: 3px; }
.confirm .optional { font-size: var(--t-sm); }
/* the letter as the candidate will read it: a sheet, not a form */
.sheet { padding: 20px 24px; border-radius: var(--r-field); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); max-width: 65ch; }
.dialog-foot { border-top: 1px solid var(--line); }
.dialog-foot .form-error { flex-basis: 100%; }
</style>
