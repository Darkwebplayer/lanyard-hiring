<script setup lang="ts">
import { addDays, type Booked, loadSchedule } from '~/composables/useTasks'

// Schedule's right side: a week of booked interviews. Yours, or (managers, ?who=everyone) the team's,
// less the people unticked in the list column.
const route = useRoute()
const { isManager } = useMe()
const everyone = computed(() => isManager.value && route.query.who === 'everyone')

const today = addDays(new Date())
const offset = useState('sched-offset', () => 0)
const monday = computed(() => addDays(today, -((today.getDay() + 6) % 7) + 7 * offset.value))
const days = computed(() => Array.from({ length: 7 }, (_, i) => addDays(monday.value, i)))

const week = useState<Booked[] | null>('sched-week', () => null)
const hidden = useState<string[]>('sched-hidden', () => [])
// weeks already seen show at once (back from a task, a week back) while a fresh copy loads behind them
const seen = useState<Record<string, Booked[]>>('sched-seen', () => ({}))
const loading = ref(false)
const error = ref('')
let ask = 0
async function load() {
  const mine = ++ask
  const key = `${monday.value.toISOString()}|${everyone.value}`
  week.value = seen.value[key] ?? null
  loading.value = true
  error.value = ''
  try {
    const s = await loadSchedule(monday.value, 7, everyone.value)
    if (mine === ask) week.value = seen.value[key] = s.events
  }
  catch (e) { if (mine === ask) error.value = (e as ApiError).message }
  finally { if (mine === ask) loading.value = false }
}
watch([monday, everyone], load, { immediate: true })

const shown = computed(() => (week.value ?? []).filter(e => !everyone.value || e.people.some(p => !hidden.value.includes(p.id))))
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60

// the hours shown: a working day, stretched to fit anything booked outside it
const span = computed(() => {
  const starts = shown.value.map(e => hourOf(new Date(e.startsAt)))
  const ends = shown.value.map(e => hourOf(new Date(e.startsAt)) + e.durationMin / 60)
  return { from: Math.floor(Math.min(8, ...starts)), to: Math.ceil(Math.max(18, ...ends)) }
})
const hours = computed(() => Array.from({ length: span.value.to - span.value.from }, (_, i) => span.value.from + i))

// each day's events in lanes, so two at once sit side by side
const columns = computed(() => days.value.map((d) => {
  const evs = shown.value.filter(e => sameDay(new Date(e.startsAt), d)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const ends: number[] = []
  const placed = evs.map((e) => {
    const s = new Date(e.startsAt).getTime()
    let lane = ends.findIndex(end => end <= s)
    if (lane < 0) lane = ends.push(0) - 1
    ends[lane] = s + e.durationMin * 60_000
    return { e, lane }
  })
  return { d, weekend: !(d.getDay() % 6), today: sameDay(d, today), lanes: Math.max(1, ends.length), placed }
}))
const grid = computed(() => `68px ${columns.value.map(c => c.weekend && !c.placed.length ? 'minmax(0, 0.45fr)' : 'minmax(0, 1fr)').join(' ')}`)
const top = (iso: string) => `calc(var(--hr) * ${hourOf(new Date(iso)) - span.value.from})`
const now = ref(new Date())
const timer = setInterval(() => (now.value = new Date()), 60_000)
onBeforeUnmount(() => clearInterval(timer))

const range = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const head = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })
const title = computed(() => `${range.format(days.value[0])} – ${range.format(days.value[6])}`)
const initials2 = (e: Booked) => e.people.map(p => initials(p.name)).join(' ')

// the card for a chosen event, beside it
const wrap = ref<HTMLElement>()
const open = ref<{ e: Booked, x: number, y: number, from: HTMLElement } | null>(null)
function choose(e: Booked, ev: MouseEvent) {
  const btn = ev.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  const w = wrap.value!.getBoundingClientRect()
  const right = r.right - w.left + 8
  open.value = { e, from: btn, x: right + 300 > w.width ? Math.max(0, r.left - w.left - 308) : right, y: Math.min(r.top - w.top, w.height - 220) }
}
function close() {
  open.value?.from.focus()
  open.value = null
}
function onDoc(ev: MouseEvent) {
  if (open.value && !(ev.target as HTMLElement).closest('.pop, .ev')) open.value = null
}
onMounted(() => document.addEventListener('click', onDoc))
onBeforeUnmount(() => document.removeEventListener('click', onDoc))
const when = (e: Booked) => `${fmtBooked(e.startsAt)} · ${e.durationMin} min`
</script>

<template>
  <div ref="wrap" class="cal-wrap" @keydown.esc="close">
    <!-- controls on the left: the corner on the right belongs to Ask -->
    <header class="cal-head">
      <button class="btn btn-sm" :disabled="offset === 0" @click="offset = 0">Today</button>
      <button class="btn btn-sm btn-icon" aria-label="Previous week" @click="offset--"><Icon name="chevron-left" /></button>
      <button class="btn btn-sm btn-icon" aria-label="Next week" @click="offset++"><Icon name="chevron-right" /></button>
      <h2 aria-live="polite">{{ title }}</h2>
      <span v-if="loading && !week" class="busy">Loading…</span>
    </header>

    <p v-if="error" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ error }} <button class="btn btn-sm" @click="load"><Icon name="retry" />Retry</button></p>

    <div class="cal" :class="{ loading: loading && !week }" :style="{ gridTemplateColumns: grid }" :aria-busy="loading" :aria-label="loading && !week ? 'Loading the week' : undefined">
      <div class="gut" />
      <div v-for="c in columns" :key="c.d.toDateString()" class="dh" :class="{ today: c.today }">
        {{ head.format(c.d) }}<i v-if="week && c.placed.length">{{ c.placed.length }}</i>
      </div>
      <div class="times" :style="{ height: `calc(var(--hr) * ${hours.length})` }">
        <span v-for="h in hours.slice(1)" :key="h" :style="{ top: `calc(var(--hr) * ${h - span.from})` }">{{ fmtTime(new Date(2000, 0, 1, h)) }}</span>
      </div>
      <div
        v-for="c in columns" :key="`c${c.d.toDateString()}`" class="col"
        :class="{ today: c.today, weekend: c.weekend }" :style="{ height: `calc(var(--hr) * ${hours.length})` }"
      >
        <span v-if="c.today && hourOf(now) >= span.from && hourOf(now) <= span.to" class="now" :style="{ top: top(now.toISOString()) }" aria-hidden="true" />
        <button
          v-for="{ e, lane } in c.placed" :key="e.runId" type="button" class="ev"
          :class="{ past: new Date(e.startsAt).getTime() + e.durationMin * 60_000 < now.getTime(), sel: open?.e.runId === e.runId, short: e.durationMin <= 30 }"
          :style="{ top: top(e.startsAt), height: `calc(var(--hr) * ${e.durationMin / 60} - 3px)`, left: `calc(${(lane / c.lanes) * 100}% + 3px)`, width: `calc(${100 / c.lanes}% - 6px)` }"
          :aria-label="`${e.title}, ${when(e)}${everyone ? `, with ${e.people.map(p => p.name).join(', ')}` : ''}`"
          :aria-expanded="open?.e.runId === e.runId"
          @click.stop="choose(e, $event)"
        >
          <b>{{ fmtTime(e.startsAt) }} {{ e.candidateName }}</b>
          <span v-if="everyone" class="by">{{ initials2(e) }}</span>
        </button>
      </div>
    </div>
    <p class="foot">Shows booked times only. Tasks without a time are in {{ everyone ? 'each person’s' : 'your' }} Tasks.</p>

    <div v-if="open" class="pop" role="dialog" :aria-label="open.e.title" :style="{ left: `${open.x}px`, top: `${open.y}px` }">
      <h3>{{ open.e.title }}</h3>
      <dl>
        <dt>When</dt><dd>{{ when(open.e) }}</dd>
        <template v-if="open.e.location"><dt>Where</dt><dd>{{ open.e.location }}</dd></template>
        <dt>With</dt><dd>{{ open.e.people.map(p => p.name).join(', ') || 'Nobody now' }}</dd>
        <dt>Job</dt><dd>{{ open.e.jobTitle }}</dd>
      </dl>
      <div class="pop-act">
        <NuxtLink v-if="isManager" class="btn btn-sm btn-primary" :to="`/candidates/${open.e.applicationId}`">Open candidate</NuxtLink>
        <NuxtLink class="btn btn-sm" :class="{ 'btn-primary': !isManager }" :to="{ path: `/inbox/${open.e.runId}`, query: route.query }">Open task</NuxtLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cal-wrap { position: relative; max-width: none !important; }
.cal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.cal-head h2 { margin-left: 8px; }
.cal-wrap > .form-error { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }

.cal {
  --hr: 60px; position: relative; display: grid; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-card); box-shadow: var(--shadow-1); overflow: hidden;
}
/* loading a week nobody has seen yet: a bar slides along the top edge; no fake events in the grid */
.cal.loading::after {
  content: ""; position: absolute; top: 0; left: 0; width: 30%; height: 3px; border-radius: 3px; background: var(--accent);
  animation: slide 1.1s var(--ease) infinite; z-index: 3;
}
@keyframes slide { from { translate: -100% 0; } to { translate: 340% 0; } }
/* with motion off the bar stands still at full width; the "Loading…" word beside the dates still says it */
@media (prefers-reduced-motion: reduce) { .cal.loading::after { width: 100%; opacity: 0.35; } }
.busy { font-size: var(--t-sm); color: var(--ink-3); }
.dh { display: flex; justify-content: space-between; gap: 4px; padding: 10px 10px 8px; border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); white-space: nowrap; overflow: hidden; }
.dh i { font-style: normal; font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.dh.today { color: var(--accent-ink); }
.gut { border-bottom: 1px solid var(--line); }
.times { position: relative; }
.times span { position: absolute; right: 8px; translate: 0 -50%; font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.col { position: relative; border-left: 1px solid var(--line); background-image: repeating-linear-gradient(to bottom, transparent 0 calc(var(--hr) - 1px), var(--line) calc(var(--hr) - 1px) var(--hr)); }
.col.today { background-color: color-mix(in oklch, var(--accent-tint) 45%, var(--surface)); }
.col.weekend { background-color: var(--sunk); }
.now { position: absolute; left: 0; right: 0; height: 2px; background: var(--accent); z-index: 2; pointer-events: none; }
.now::before { content: ""; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }

.ev {
  position: absolute; display: grid; align-content: start; gap: 1px; padding: 4px 7px; overflow: hidden; text-align: left;
  border: 0; border-radius: 8px; background: var(--accent-tint); color: var(--ink); font-size: var(--t-xs); line-height: 1.25; cursor: pointer;
  transition: background var(--t-micro) var(--ease);
}
/* the week's interviews arrive together, softly, not one by one */
.ev { animation: arrive var(--t-micro) var(--ease); }
@keyframes arrive { from { opacity: 0; } }
.ev:hover { background: color-mix(in oklch, var(--accent-tint), var(--accent) 12%); }
.ev b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ev .by { color: var(--accent-ink); font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ev.short { grid-auto-flow: column; justify-content: start; align-items: center; gap: 6px; padding-block: 2px; }
.ev.past { background: var(--sunk); color: var(--ink-3); }
.ev.past .by { color: var(--ink-3); }
.ev.sel { box-shadow: 0 0 0 2px var(--accent); }
.foot { margin-top: 10px; font-size: var(--t-sm); color: var(--ink-2); }

.pop { position: absolute; z-index: 5; width: 300px; padding: 16px; display: grid; gap: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); box-shadow: var(--shadow-3); animation: rise var(--t-micro) var(--ease); }
.pop h3 { font-size: var(--t-lg); }
.pop dl { margin: 0; display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 4px 10px; font-size: var(--t-sm); }
.pop dt { color: var(--ink-3); }
.pop dd { margin: 0; overflow-wrap: anywhere; }
.pop-act { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
