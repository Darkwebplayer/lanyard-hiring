<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface Booking {
  companyName: string | null, logoUrl: string | null, jobTitle: string, candidateFirstName: string, interviewers: string[], offeredBy: string | null
  durationMin: number, location: string | null, cancelled: boolean, declined: boolean, closed: boolean, timezoneHint: string | null
  startsAt: string | null, options: string[], asked: string | null, canChange: boolean
}

// Client-only (routeRules '/**'): the times are shown in the candidate's own clock and zone anyway.
const token = useRoute().params.token as string
const base = `/api/public/bookings/${encodeURIComponent(token)}`
const b = ref<Booking | null>(null)
const loadError = ref<{ status: number, message: string } | null>(null)
async function load() {
  loadError.value = null
  try {
    b.value = await api<Booking>(base)
  }
  catch (e) {
    const err = toApiError(e)
    loadError.value = { status: err.status, message: err.message }
  }
}
onMounted(load)
useHead({ title: () => (b.value ? `Pick a time · ${b.value.jobTitle}` : 'Pick a time') })

// ---- the candidate's time zone: detected, changeable, always named ----
const detected = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' } })()
const tz = ref(detected || 'UTC')
watch(b, (v) => { if (!detected && v?.timezoneHint && tz.value === 'UTC') tz.value = v.timezoneHint }, { once: true })
const zones = (() => { try { return Intl.supportedValuesOf('timeZone') } catch { return [] as string[] } })()
const zoneOptions = computed(() => (zones.includes(tz.value) ? zones : [tz.value, ...zones]))
const changingZone = ref(false)
const zoneSelect = ref<HTMLSelectElement>()
async function openZone() {
  changingZone.value = true
  await nextTick()
  zoneSelect.value?.focus()
}
// Some browsers still report a zone by its old id; name the city as people now write it.
// ponytail: the renames people are likely to meet, not the whole backward file; add one when a candidate sees it
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Kolkata', 'Asia/Saigon': 'Ho Chi Minh', 'Asia/Katmandu': 'Kathmandu', 'Asia/Rangoon': 'Yangon',
  'Europe/Kiev': 'Kyiv', 'America/Godthab': 'Nuuk', 'Atlantic/Faeroe': 'Faroe', 'Asia/Ulan_Bator': 'Ulaanbaatar',
}
// "Europe/London" → "London time (BST)"
const zoneName = computed(() => {
  const city = RENAMED[tz.value] ?? tz.value.split('/').pop()!.replace(/_/g, ' ')
  const short = new Intl.DateTimeFormat('en', { timeZone: tz.value, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value
  return `${city} time${short && short !== city ? ` (${short})` : ''}`
})

const fmt = (opts: Intl.DateTimeFormatOptions) => computed(() => new Intl.DateTimeFormat(undefined, { timeZone: tz.value, ...opts }))
const timeF = fmt({ hour: 'numeric', minute: '2-digit' })
const longF = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const fullF = fmt({ weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
const until = (iso: string) => timeF.value.format(new Date(new Date(iso).getTime() + (b.value?.durationMin ?? 0) * 60_000))

const people = computed(() => {
  const n = b.value?.interviewers ?? []
  return n.length <= 1 ? n[0] ?? '' : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`
})
const company = computed(() => b.value?.companyName || 'the team')
const host = computed(() => b.value?.offeredBy?.split(' ')[0] ?? company.value)

// what the page is doing: picking from the times, writing a note for other times, or stepping back
const mode = ref<'pick' | 'other' | 'decline'>('pick')
const pick = ref('')
watch(() => b.value?.options, (o) => { if (!o?.includes(pick.value)) pick.value = '' })
const note = ref('')
const busy = ref(false)
const actError = ref('')
const justBooked = ref(false)
const ERR: Record<string, string> = {
  slot_unavailable: 'Someone took that time a moment ago. Pick another, or ask for other times.',
  too_late_to_change: 'Your interview is less than 12 hours away, so the time can’t change here.',
  booking_closed: 'This interview can’t be booked any more.',
}
async function act(run: () => Promise<unknown>) {
  busy.value = true
  actError.value = ''
  try {
    await run()
    await load()
    return true
  }
  catch (e) {
    const err = toApiError(e)
    const known = ERR[err.code]
    actError.value = known ? `${known}${err.code === 'too_late_to_change' ? ` Reply to the email from ${company.value} to move it.` : ''}` : err.message
    if (known) await load()
    return false
  }
  finally { busy.value = false }
}
async function confirm() {
  if (!pick.value) return (actError.value = 'Pick a time first.')
  if (await act(() => api(base, { method: 'POST', body: { startsAt: pick.value, timezone: tz.value } }))) justBooked.value = true // the email says the time in their zone
}
async function askOther() {
  if (await act(() => api(`${base}/other`, { method: 'POST', body: note.value.trim() ? { note: note.value.trim() } : {} }))) (mode.value = 'pick', note.value = '')
}
async function decline() {
  if (await act(() => api(`${base}/decline`, { method: 'POST', body: note.value.trim() ? { note: note.value.trim() } : {} }))) (mode.value = 'pick', note.value = '')
}
function to(m: typeof mode.value) {
  mode.value = m
  actError.value = ''
  justBooked.value = false
}
// booked but locked: within the 12 hours' notice
const soon = computed(() => { const t = b.value?.startsAt ? new Date(b.value.startsAt).getTime() - Date.now() : -1; return t > 0 && !b.value?.canChange })
</script>

<template>
  <main class="book">
    <p v-if="b?.logoUrl" class="brand"><img :src="b.logoUrl" :alt="b.companyName ?? 'Company logo'" class="logo"></p>
    <p v-else-if="b?.companyName" class="brand"><span class="mono-mark" aria-hidden="true">{{ b.companyName[0]!.toUpperCase() }}</span><b>{{ b.companyName }}</b></p>

    <div v-if="loadError?.status === 404" class="card sheet">
      <h1>This booking link doesn’t work</h1>
      <p class="muted">It may be mistyped, or a newer link replaced it. Reply to the email that brought you here and ask for a new one.</p>
    </div>

    <div v-else-if="loadError" class="card sheet" role="alert">
      <h1>This page didn’t load.</h1>
      <p class="muted">{{ loadError.message }}</p>
      <button class="btn" @click="load">Try again</button>
    </div>

    <div v-else-if="!b" class="card sheet" aria-busy="true">
      <div class="skeleton" style="height: 30px; width: 80%" />
      <div class="skeleton" style="height: 16px; width: 55%" />
      <div class="skeleton" style="height: 120px" />
    </div>

    <div v-else-if="b.cancelled" class="card sheet">
      <h1>This interview was cancelled</h1>
      <p class="muted">Your application has moved on, so it no longer goes ahead<template v-if="b.startsAt"> on {{ fullF.format(new Date(b.startsAt)) }}</template>. {{ b.companyName ?? 'The team' }} will be in touch, or reply to their email with any questions.</p>
    </div>

    <div v-else-if="b.declined" class="card sheet" aria-live="polite">
      <h1>You stepped back from this interview</h1>
      <p class="muted">We let {{ people || 'the team' }} know. Your application stays with {{ company }}, and they may get in touch. Changed your mind? Reply to their email.</p>
    </div>

    <div v-else-if="b.closed" class="card sheet">
      <h1>This interview can’t be booked any more</h1>
      <p class="muted">Your application has moved on since this link was sent. {{ b.companyName ?? 'The team' }} will be in touch about what happens next.</p>
    </div>

    <!-- step back: asked once more, inline -->
    <section v-else-if="mode === 'decline'" class="card sheet" aria-labelledby="dc-h">
      <div><h1 id="dc-h">Step back from this interview?</h1><p class="sub">We’ll let {{ people || 'the team' }} know. Your application stays with {{ company }}, and they may get in touch.</p></div>
      <label class="field"><span class="label">Anything you’d like them to know? <span class="faint">(optional)</span></span><textarea v-model="note" rows="3" maxlength="1000" /></label>
      <p v-if="actError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ actError }}</p>
      <button class="btn btn-lg bad" :aria-busy="busy" :disabled="busy" @click="decline"><span v-if="busy" class="spinner" />Step back from the interview</button>
      <button class="btn btn-lg btn-quiet" @click="to('pick')">Keep my interview</button>
    </section>

    <!-- none of these work: a note for the team -->
    <section v-else-if="mode === 'other'" class="card sheet" aria-labelledby="ot-h">
      <div>
        <h1 id="ot-h">{{ b.startsAt ? 'Need a different time?' : `When suits you, ${b.candidateFirstName}?` }}</h1>
        <p class="sub">{{ host }} will send new times that fit.<template v-if="b.startsAt"> Your interview stays on {{ longF.format(new Date(b.startsAt)) }} until you pick a new one.</template></p>
      </div>
      <label class="field"><span class="label">Your note to {{ host }}</span><textarea v-model="note" rows="4" maxlength="1000" /><small class="muted">For example, the days or hours that work for you.</small></label>
      <p v-if="actError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ actError }}</p>
      <button class="btn btn-primary btn-lg" :aria-busy="busy" :disabled="busy" @click="askOther"><span v-if="busy" class="spinner" />Ask for other times</button>
      <button class="btn btn-lg" @click="to('pick')">{{ b.options.length ? 'Back to the times' : 'Back' }}</button>
    </section>

    <!-- times to pick (also to move a booked one) -->
    <section v-else-if="b.options.length" class="card sheet" aria-labelledby="pk-h">
      <div>
        <h1 id="pk-h">{{ b.startsAt ? `New times for your interview, ${b.candidateFirstName}` : `Hi ${b.candidateFirstName}, pick a time for your interview` }}</h1>
        <p class="sub">{{ b.jobTitle }} · {{ b.durationMin }} minutes<template v-if="people"> with {{ people }}</template></p>
        <p v-if="b.location" class="sub">Where: {{ b.location }}</p>
        <p v-if="b.startsAt" class="sub">Booked now: {{ fullF.format(new Date(b.startsAt)) }}. It stays until you pick a new time.</p>
      </div>
      <fieldset class="opts">
        <legend>{{ b.interviewers.length > 1 ? 'Times that work for everyone' : 'Times that work' }}</legend>
        <label v-for="o in b.options" :key="o" class="opt">
          <input v-model="pick" type="radio" name="time" :value="o">
          <b>{{ longF.format(new Date(o)) }}</b><small>until {{ until(o) }}</small>
        </label>
      </fieldset>
      <div class="zone">
        <template v-if="!changingZone">Times in {{ zoneName }}. <button type="button" class="link" @click="openZone">Change</button></template>
        <label v-else class="field">
          <span class="label">Your time zone</span>
          <select ref="zoneSelect" v-model="tz" @change="changingZone = false">
            <option v-for="z in zoneOptions" :key="z" :value="z">{{ z.replace(/_/g, ' ') }}</option>
          </select>
        </label>
      </div>
      <p v-if="actError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ actError }}</p>
      <button class="btn btn-primary btn-lg" :aria-busy="busy" :disabled="busy" @click="confirm">
        <span v-if="busy" class="spinner" /><span>{{ pick ? `${b.startsAt ? 'Move to' : 'Book'} ${longF.format(new Date(pick))}` : 'Pick a time above' }}</span>
      </button>
      <hr class="rule">
      <div class="more">
        <button type="button" class="link" @click="to('other')">None of these work</button>
        <button v-if="!b.startsAt" type="button" class="link quiet" @click="to('decline')">I’m no longer interested</button>
      </div>
    </section>

    <!-- booked -->
    <section v-else-if="b.startsAt" class="card sheet" aria-labelledby="bk-h" :aria-live="justBooked ? 'polite' : undefined">
      <div>
        <h1 id="bk-h">{{ justBooked ? `You’re booked, ${b.candidateFirstName}` : `Your interview, ${b.candidateFirstName}` }}</h1>
        <p class="sub">{{ b.jobTitle }} · {{ b.durationMin }} minutes<template v-if="people"> with {{ people }}</template></p>
      </div>
      <p class="when"><Icon name="calendar" :size="20" /><span>{{ fullF.format(new Date(b.startsAt)) }}<small>{{ zoneName }}</small></span></p>
      <p v-if="b.location" class="when"><Icon name="pin" :size="20" /><span>{{ b.location }}<small>Where</small></span></p>
      <p v-if="b.asked !== null" class="muted small">You asked for another time. {{ host }} will email you new times; this one stays until you pick.</p>
      <p v-else-if="justBooked" class="muted small">We’ve emailed this to you too, and sent {{ people || 'the team' }} a calendar invite.</p>
      <a class="btn btn-primary btn-lg" :href="`${base}/invite.ics`" download="interview.ics"><Icon name="download" />Add to calendar</a>
      <div v-if="b.canChange" class="more">
        <button type="button" class="link" @click="to('other')">Need a different time?</button>
        <button type="button" class="link quiet" @click="to('decline')">I’m no longer interested</button>
      </div>
      <p v-else-if="soon" class="muted small">It’s less than 12 hours away, so the time can’t change here. To move it, reply to the email from {{ company }}.</p>
      <p v-if="actError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ actError }}</p>
    </section>

    <!-- waiting for new times -->
    <section v-else class="card sheet" aria-live="polite">
      <div>
        <h1>{{ b.asked !== null ? `We’ve asked ${host} for other times` : 'New times are on their way' }}</h1>
        <p class="sub">{{ b.asked !== null ? 'You’ll get an email with new times, usually within a working day. This link stays the same.' : `The times we offered have passed or been taken. ${host} will email you new ones, and this link stays the same.` }}</p>
      </div>
      <div v-if="b.asked" class="when said"><span><b>You said</b><small>“{{ b.asked }}”</small></span></div>
      <div class="more">
        <button v-if="b.asked === null" type="button" class="link" @click="to('other')">Tell them when suits you</button>
        <button type="button" class="link quiet" @click="to('decline')">I’m no longer interested</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* Ink and paper like the apply page; magenta only on the one action. */
.book { width: min(560px, 100%); margin-inline: auto; padding: 40px 16px 64px; display: grid; gap: 20px; align-content: start; }
.book :deep(:focus-visible) { outline-color: var(--ink); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand b { overflow-wrap: anywhere; }
.logo { display: block; height: 32px; max-width: min(180px, 60vw); object-fit: contain; object-position: left; }
.mono-mark { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--ink); color: #fff; font-size: var(--t-xs); font-weight: 600; }
.sheet { padding: 24px; display: grid; gap: 18px; box-shadow: inset 0 0 0 1px var(--line); border: 0; }
@media (max-width: 400px) { .sheet { padding: 20px 16px; } }
.sheet h1 { font-size: var(--t-2xl); letter-spacing: -0.015em; overflow-wrap: anywhere; }
.sub { margin-top: 6px; color: var(--ink-2); }
.opts { display: grid; gap: 8px; border: 0; padding: 0; margin: 0; min-width: 0; }
.opts legend { padding: 0; margin-bottom: 8px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.opt { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 2px 12px; align-items: center; min-height: 44px; padding: 12px 14px; border-radius: var(--r-panel); box-shadow: inset 0 0 0 1px var(--line-2); cursor: pointer; transition: box-shadow var(--t-micro) var(--ease); }
.opt:hover { box-shadow: inset 0 0 0 1px var(--ink-3); }
.opt input { appearance: none; margin: 0; width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-2); grid-row: span 2; display: grid; place-content: center; background: var(--surface); }
.opt input:checked { border-color: var(--ink); }
.opt input:checked::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--ink); }
.opt input:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.opt:has(input:checked) { box-shadow: inset 0 0 0 2px var(--ink); }
.opt b { font-size: var(--t-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
.opt small { font-size: var(--t-sm); color: var(--ink-2); }
.rule { border: 0; border-top: 1px solid var(--line); margin: 0; }
.more { display: flex; flex-wrap: wrap; gap: 4px 20px; }
.link.quiet { color: var(--ink-2); font-weight: 500; }
.bad { color: var(--bad); }
.said { font-size: var(--t-md); font-weight: 400; }
.said small { font-size: var(--t-md); color: var(--ink); }
.field textarea { width: 100%; }
.zone { font-size: var(--t-sm); color: var(--ink-2); }
.zone select { margin-top: 6px; min-height: 44px; }
.zone select:focus-visible { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px oklch(0.24 0.018 330 / 0.14); }
/* padding grows the target to 44 px tall, the negative margin keeps the sentence where it was */
.link { border: 0; background: none; padding: 12px 8px; margin: -12px -8px; font: inherit; font-weight: 600; line-height: 20px; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.when { display: flex; gap: 12px; align-items: flex-start; padding: 16px; border-radius: var(--r-panel); background: var(--sunk); font-size: var(--t-lg); font-weight: 600; }
.when svg { flex: none; margin-top: 2px; }
.when span { display: grid; gap: 2px; }
.when small { font-size: var(--t-sm); font-weight: 400; color: var(--ink-2); }
.small { font-size: var(--t-sm); }
@media (prefers-reduced-motion: reduce) { .opt { transition: none; } }
</style>
