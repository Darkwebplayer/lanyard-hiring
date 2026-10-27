<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface Booking {
  companyName: string | null, logoUrl: string | null, jobTitle: string, candidateFirstName: string, interviewers: string[], durationMin: number
  location: string | null, cancelled: boolean, timezoneHint: string | null, startsAt: string | null, canBook: boolean, noAvailability: boolean, slots: string[]
}

// Client-only (routeRules '/**'): the slots depend on the candidate's own clock and zone anyway.
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
const dayKeyF = computed(() => new Intl.DateTimeFormat('en-CA', { timeZone: tz.value, year: 'numeric', month: '2-digit', day: '2-digit' }))
const weekdayF = fmt({ weekday: 'short' })
const dayNumF = fmt({ day: 'numeric' })
const timeF = fmt({ hour: 'numeric', minute: '2-digit' })
const longF = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const fullF = fmt({ weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })

// only days that have a free slot, in the candidate's zone
const days = computed(() => {
  const map = new Map<string, string[]>()
  for (const s of b.value?.slots ?? []) {
    const k = dayKeyF.value.format(new Date(s))
    map.set(k, [...(map.get(k) ?? []), s])
  }
  return [...map].map(([key, slots]) => ({ key, slots, weekday: weekdayF.value.format(new Date(slots[0]!)), num: dayNumF.value.format(new Date(slots[0]!)) }))
})
const dayKey = ref('')
const day = computed(() => days.value.find(d => d.key === dayKey.value) ?? days.value[0])
const pick = ref('')
watch(days, () => { if (!day.value?.slots.includes(pick.value)) pick.value = '' })

const people = computed(() => {
  const n = b.value?.interviewers ?? []
  return n.length <= 1 ? n[0] ?? '' : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`
})
const company = computed(() => b.value?.companyName || 'the team')

// ---- booking ----
const changing = ref(false) // picking a new time after booking
const busy = ref(false)
const bookError = ref('')
const justBooked = ref(false)
const ERR: Record<string, string> = {
  slot_unavailable: 'Someone took that time a moment ago. The times below are up to date; pick another.',
  too_late_to_change: 'Your interview is less than 12 hours away, so the time can’t change here.',
  booking_closed: 'This interview can’t be booked any more.',
}
async function confirm() {
  if (!pick.value) return
  busy.value = true
  bookError.value = ''
  try {
    await api(base, { method: 'POST', body: { startsAt: pick.value, timezone: tz.value } }) // the email says the time in their zone
    changing.value = false
    justBooked.value = true
    await load()
  }
  catch (e) {
    const err = toApiError(e)
    const known = ERR[err.code]
    bookError.value = known ? `${known}${err.code === 'too_late_to_change' ? ` Reply to the email from ${company.value} to move it.` : ''}` : err.message
    if (known) { pick.value = ''; await load() }
  }
  finally {
    busy.value = false
  }
}
// booked but locked: within the 12 hours' notice (otherwise the step has finished and there's nothing to say)
const soon = computed(() => { const t = b.value?.startsAt ? new Date(b.value.startsAt).getTime() - Date.now() : -1; return t > 0 && t < 12 * 3600_000 })
const picking = computed(() => !!b.value?.canBook && (!b.value.startsAt || changing.value))
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

    <!-- booked, not changing -->
    <section v-else-if="b.startsAt && !changing" class="card sheet" aria-labelledby="bk-h" :aria-live="justBooked ? 'polite' : undefined">
      <div>
        <h1 id="bk-h">{{ justBooked ? `You’re booked, ${b.candidateFirstName}` : `Your interview, ${b.candidateFirstName}` }}</h1>
        <p class="sub">{{ b.jobTitle }} · {{ b.durationMin }} minutes<template v-if="people"> with {{ people }}</template></p>
      </div>
      <p class="when"><Icon name="calendar" :size="20" /><span>{{ fullF.format(new Date(b.startsAt)) }}<small>{{ zoneName }}</small></span></p>
      <p v-if="b.location" class="when"><Icon name="pin" :size="20" /><span>{{ b.location }}<small>Where</small></span></p>
      <p v-if="justBooked" class="muted small">We’ve emailed this to you too.</p>
      <div class="row">
        <a class="btn btn-primary btn-lg" :href="`${base}/invite.ics`" download="interview.ics"><Icon name="download" />Add to calendar</a>
        <button v-if="b.canBook" class="btn btn-lg" @click="changing = true; bookError = ''">Change time</button>
      </div>
      <p v-if="!b.canBook && soon" class="muted small">It’s less than 12 hours away, so the time can’t change here. To move it, reply to the email from {{ company }}.</p>
      <p v-if="bookError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ bookError }}</p>
    </section>

    <div v-else-if="!b.canBook" class="card sheet">
      <h1>This interview can’t be booked any more</h1>
      <p class="muted">Your application has moved on since this link was sent. {{ b.companyName ?? 'The team' }} will be in touch about what happens next.</p>
    </div>

    <section v-else class="card sheet" aria-labelledby="pk-h">
      <div>
        <h1 id="pk-h">Hi {{ b.candidateFirstName }}, pick a time for your interview</h1>
        <p class="sub">{{ b.jobTitle }} · {{ b.durationMin }} minutes<template v-if="people"> with {{ people }}</template></p>
        <p v-if="b.location" class="sub">Where: {{ b.location }}</p>
      </div>

      <p v-if="bookError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ bookError }}</p>

      <div v-if="!days.length" class="none">
        <h2>{{ b.noAvailability ? 'No times are open yet' : 'Every time in the next two weeks is taken' }}</h2>
        <p class="muted">Reply to the email from {{ company }} and they’ll find a time with you.</p>
      </div>

      <template v-else>
        <div class="days" role="group" aria-label="Day">
          <button
            v-for="d in days" :key="d.key" type="button" class="day" :aria-pressed="d.key === day?.key"
            @click="dayKey = d.key; pick = ''"
          ><small>{{ d.weekday }}</small><b>{{ d.num }}</b></button>
        </div>
        <div class="slots" role="group" :aria-label="`Times on ${day?.weekday} ${day?.num}`">
          <button
            v-for="s in day?.slots" :key="s" type="button" class="slot" :aria-pressed="s === pick"
            @click="pick = s"
          >{{ timeF.format(new Date(s)) }}</button>
        </div>
      </template>

      <div class="zone">
        <template v-if="!changingZone">Times in {{ zoneName }}. <button type="button" class="link" @click="openZone">Change</button></template>
        <label v-else class="field">
          <span class="label">Your time zone</span>
          <select ref="zoneSelect" v-model="tz" @change="changingZone = false">
            <option v-for="z in zoneOptions" :key="z" :value="z">{{ z.replace(/_/g, ' ') }}</option>
          </select>
        </label>
      </div>

      <div v-if="days.length || changing" class="row">
        <button v-if="days.length" class="btn btn-primary btn-lg grow" :aria-busy="busy" :disabled="busy" @click="pick ? confirm() : (bookError = 'Pick a time first.')">
          <span v-if="busy" class="spinner" />
          <span>{{ pick ? `${changing ? 'Move to' : 'Book'} ${longF.format(new Date(pick))}` : 'Pick a time above' }}</span>
        </button>
        <button v-if="changing" class="btn btn-lg" @click="changing = false; bookError = ''">Keep {{ longF.format(new Date(b.startsAt!)) }}</button>
      </div>
    </section>

    <p v-if="b && picking && days.length" class="foot">None of these times work? Reply to the email from {{ company }}.</p>
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
.days { display: flex; gap: 8px; overflow-x: auto; padding: 2px; scrollbar-width: none; }
/* with a mouse a sideways strip hides days behind a scroll nobody can see: the tiles narrow (to 40 px) so the
   two weeks' working days share one row, and wrap only past that. A phone keeps the swipe, and the cut-off
   day at the edge shows there is more */
@media (hover: hover) and (pointer: fine) {
  .days { flex-wrap: wrap; overflow: visible; }
  .days .day { flex: 1 1 40px; width: auto; max-width: 56px; }
}
.day {
  flex: none; display: grid; justify-items: center; gap: 2px; width: 56px; padding: 8px 0; border: 0; border-radius: var(--r-panel);
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--ink); font: inherit; cursor: pointer;
  transition: background var(--t-micro) var(--ease), box-shadow var(--t-micro) var(--ease);
}
.day small { font-size: var(--t-xs); color: var(--ink-2); }
.day b { font-size: var(--t-xl); font-variant-numeric: tabular-nums; }
.day[aria-pressed="true"] { background: var(--ink); color: #fff; box-shadow: none; }
.day[aria-pressed="true"] small { color: oklch(1 0 0 / 0.75); }
.slots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.slot {
  height: 44px; border: 0; border-radius: var(--r-field); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2);
  color: var(--ink); font: 500 var(--t-lg) var(--font); font-variant-numeric: tabular-nums; cursor: pointer;
  transition: background var(--t-micro) var(--ease), box-shadow var(--t-micro) var(--ease);
}
.slot:hover, .day:hover:not([aria-pressed="true"]) { box-shadow: inset 0 0 0 1px var(--ink-3); }
.slot[aria-pressed="true"] { background: var(--ink); color: #fff; box-shadow: none; }
.zone { font-size: var(--t-sm); color: var(--ink-2); }
.zone select { margin-top: 6px; min-height: 44px; }
.zone select:focus-visible { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px oklch(0.24 0.018 330 / 0.14); }
/* padding grows the target to 44 px tall, the negative margin keeps the sentence where it was */
.link { border: 0; background: none; padding: 12px 8px; margin: -12px -8px; font: inherit; font-weight: 600; line-height: 20px; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.grow { flex: 1 1 auto; }
.row .btn { max-width: 100%; }
.when { display: flex; gap: 12px; align-items: flex-start; padding: 16px; border-radius: var(--r-panel); background: var(--sunk); font-size: var(--t-lg); font-weight: 600; }
.when svg { flex: none; margin-top: 2px; }
.when span { display: grid; gap: 2px; }
.when small { font-size: var(--t-sm); font-weight: 400; color: var(--ink-2); }
.none { display: grid; gap: 6px; padding: 16px; border-radius: var(--r-panel); background: var(--sunk); }
.none h2 { font-size: var(--t-lg); }
.small { font-size: var(--t-sm); }
.foot { font-size: var(--t-sm); color: var(--ink-2); text-align: center; }
@media (prefers-reduced-motion: reduce) { .day, .slot { transition: none; } }
</style>
