<script setup lang="ts">
// Your interview hours. In the inbox, not Settings, because Settings is for admins and interviewers
// (level employee) only have the inbox; everyone who can be booked needs this page.
useHead({ title: 'Interview availability' })

type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
interface Availability { timezone: string | null, hours: Partial<Record<Day, [string, string][]>> }

// Monday first, the working week before the weekend
const DAYS: { key: Day, label: string }[] = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' }, { key: 'wed', label: 'Wednesday' }, { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' }, { key: 'sun', label: 'Sunday' },
]
const here = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = (() => {
  try { return Intl.supportedValuesOf('timeZone') }
  catch { return [here] }
})()

const timezone = ref(here)
const days = ref<Record<Day, { on: boolean, ranges: [string, string][] }>>(Object.fromEntries(DAYS.map(d => [d.key, { on: false, ranges: [] }])) as never)
const firstTime = ref(false)
const loaded = ref(false)
const loadError = ref('')
const pristine = ref('')
const snap = () => JSON.stringify([timezone.value, days.value])

async function load() {
  loadError.value = ''
  try {
    const a = await api<Availability>('/api/me/availability')
    firstTime.value = !a.timezone
    timezone.value = a.timezone ?? here
    for (const d of DAYS) {
      const r = a.hours[d.key] ?? []
      days.value[d.key] = { on: r.length > 0, ranges: r.length ? r.map(x => [...x] as [string, string]) : [['09:00', '17:00']] }
    }
    // a first visit starts from a working week, so most people only press Save
    if (firstTime.value) for (const d of DAYS.slice(0, 5)) days.value[d.key].on = true
    pristine.value = firstTime.value ? '' : snap()
    loaded.value = true
  }
  catch (e) { loadError.value = toApiError(e).message }
}
load()
const dirty = computed(() => loaded.value && snap() !== pristine.value)

const bad = (r: [string, string]) => !r[0] || !r[1] || r[0] >= r[1]
const problem = computed(() => DAYS.some(d => days.value[d.key].on && days.value[d.key].ranges.some(bad)) ? 'Each range needs to end after it starts.' : '')
function addRange(d: Day) {
  const r = days.value[d].ranges
  const last = r.at(-1)?.[1] ?? '09:00'
  // the next range starts an hour after the last ends, so it's valid as it appears
  const h = Math.min(Number(last.slice(0, 2)) + 1, 22)
  r.push([`${String(h).padStart(2, '0')}:00`, `${String(h + 1).padStart(2, '0')}:00`])
}
function removeRange(d: Day, i: number) {
  const day = days.value[d]
  day.ranges.splice(i, 1)
  if (!day.ranges.length) (day.on = false, day.ranges.push(['09:00', '17:00']))
}

const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
watch([timezone, days], () => { saved.value = false }, { deep: true })
async function save() {
  if (problem.value) return
  saving.value = true
  saveError.value = ''
  try {
    const hours = Object.fromEntries(DAYS.filter(d => days.value[d.key].on).map(d => [d.key, days.value[d.key].ranges]))
    await api('/api/me/availability', { method: 'PUT', body: { timezone: timezone.value, hours } })
    pristine.value = snap()
    firstTime.value = false
    saved.value = true
  }
  catch (e) { saveError.value = toApiError(e).message }
  finally { saving.value = false }
}
onBeforeRouteLeave(() => !dirty.value || firstTime.value || confirm('Leave without saving your interview availability?'))
</script>

<template>
  <div class="hours">
    <header class="top">
      <h2>Interview availability</h2>
      <p class="muted">Candidates can only book an interview with you inside these hours.</p>
    </header>

    <div v-if="loadError" class="empty" role="alert">
      <h2>Your availability didn’t load</h2>
      <p>{{ loadError }}</p>
      <button type="button" class="btn" @click="load"><Icon name="retry" />Try again</button>
    </div>

    <form v-else class="card body" :aria-busy="!loaded" :inert="!loaded" @submit.prevent="save">
      <p v-if="firstTime" class="first"><Icon name="calendar" :size="16" />You haven’t set hours yet, so nobody can book you. Here’s a working week to start from.</p>

      <div class="field tz">
        <label for="h-tz">Time zone</label>
        <select id="h-tz" v-model="timezone">
          <option v-for="z in zones" :key="z" :value="z">{{ z.replaceAll('_', ' ') }}</option>
        </select>
      </div>

      <ul class="days">
        <li v-for="d in DAYS" :key="d.key" class="day" :class="{ off: !days[d.key].on }">
          <label class="day-on">
            <input v-model="days[d.key].on" type="checkbox" role="switch" :aria-label="`Available on ${d.label}`">
            <span>{{ d.label }}</span>
          </label>
          <div v-if="days[d.key].on" class="ranges">
            <div v-for="(r, i) in days[d.key].ranges" :key="i" class="range">
              <input v-model="r[0]" type="time" step="900" :aria-label="`${d.label}, from`" :aria-invalid="bad(r) || undefined">
              <span class="faint" aria-hidden="true">to</span>
              <input v-model="r[1]" type="time" step="900" :aria-label="`${d.label}, until`" :aria-invalid="bad(r) || undefined">
              <button type="button" class="btn btn-sm btn-quiet btn-icon" :aria-label="`Remove ${r[0]} to ${r[1]} on ${d.label}`" @click="removeRange(d.key, i)"><Icon name="x" :size="16" /></button>
            </div>
            <button v-if="days[d.key].ranges.length < 10" type="button" class="btn btn-sm btn-quiet add" @click="addRange(d.key)"><Icon name="plus" />Add hours</button>
          </div>
          <span v-else-if="loaded" class="faint unavail">Not available</span>
          <span v-else class="unavail"><span class="skeleton" style="height: 14px; width: 180px" /></span>
        </li>
      </ul>

      <p v-if="problem" class="err" role="alert"><Icon name="alert" :size="14" />{{ problem }}</p>
      <div class="foot">
        <button class="btn btn-primary" :disabled="saving || !!problem" :aria-busy="saving"><span v-if="saving" class="spinner" />Save hours</button>
        <span aria-live="polite" class="status">
          <span v-if="saved" class="ok"><Icon name="check" :size="16" />Saved. New booking times use these hours.</span>
          <span v-else-if="saveError" class="err"><Icon name="alert" :size="16" />{{ saveError }}</span>
        </span>
      </div>
    </form>
  </div>
</template>

<style scoped>
.hours { display: grid; gap: 16px; }
.top { display: grid; gap: 4px; }
.top h2 { font-size: var(--t-xl); }
.body { padding: 24px 28px; display: grid; gap: 20px; }
.first { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-radius: var(--r-panel); background: var(--accent-tint); color: var(--ink); font-weight: 500; }
.first svg { color: var(--accent-ink); flex: none; }
.tz { max-width: 360px; }
.days { list-style: none; margin: 0; padding: 0; display: grid; }
/* a week as rows: day on the left, its ranges beside it, like a paper rota */
.day { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 12px; align-items: start; padding: 10px 0; border-top: 1px solid var(--line); }
.day:first-child { border-top: 0; }
.day-on { display: inline-flex; align-items: center; gap: 10px; min-height: var(--h-sm); font-weight: 600; cursor: pointer; }
.day.off .day-on span { color: var(--ink-2); font-weight: 500; }
.unavail { min-height: var(--h-sm); display: flex; align-items: center; font-size: var(--t-sm); }
.ranges { display: grid; gap: 6px; justify-items: start; }
.range { display: flex; align-items: center; gap: 8px; }
.range input { width: auto; min-width: 8.5em; min-height: var(--h-sm); font-variant-numeric: tabular-nums; }
.add { margin-left: -8px; }
/* the switch: the same one the step library uses for "In palette" */
/* a transparent 2px border grows the target to 38 × 24 (the 24 px minimum) while the track still draws 34 × 20 */
.day-on input { width: 38px; height: 24px; border-radius: 99px; border: 2px solid transparent; background: var(--line-2) padding-box; position: relative; flex: none; }
.day-on input::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; scale: 1; clip-path: none; box-shadow: 0 1px 2px oklch(0.3 0.04 330 / 0.3); transition: translate var(--t-micro) var(--ease); }
.day-on input:checked { background: var(--ink) padding-box; border-color: transparent; }
.day-on input:checked::before { translate: 14px 0; }
.err { display: inline-flex; gap: 6px; align-items: center; color: var(--bad); font-size: var(--t-sm); font-weight: 500; }
.foot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.ok { display: inline-flex; gap: 6px; align-items: center; color: var(--ok); font-weight: 500; font-size: var(--t-sm); }
@media (prefers-reduced-motion: reduce) { .day-on input::before { transition: none; } }
</style>
