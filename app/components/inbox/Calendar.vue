<script setup lang="ts">
import { addDays, type Booked, type Draft, loadSchedule, type Offered, useOffering } from '~/composables/useTasks'

// Schedule's right side: a week of booked interviews. Yours, or (managers, ?who=everyone) the team's,
// less the people unticked in the list column. On your own week it is also where times are offered:
// drag a person from Needs times onto it (a line shows the start), and Send.
const route = useRoute()
const { isManager } = useMe()
const everyone = computed(() => isManager.value && route.query.who === 'everyone')
const { needs, drafts, current, dragging, rev } = useOffering()

const today = addDays(new Date())
const offset = useState('sched-offset', () => 0)
const monday = computed(() => addDays(today, -((today.getDay() + 6) % 7) + 7 * offset.value))
const days = computed(() => Array.from({ length: 7 }, (_, i) => addDays(monday.value, i)))

const week = useState<Booked[] | null>('sched-week', () => null)
const offered = ref<Offered[]>([])
const hidden = useState<string[]>('sched-hidden', () => [])
// weeks already seen show at once (back from a task, a week back) while a fresh copy loads behind them
const seen = useState<Record<string, { events: Booked[], offered: Offered[] }>>('sched-seen', () => ({}))
const loading = ref(false)
const error = ref('')
let ask = 0
async function load() {
  const mine = ++ask
  const key = `${monday.value.toISOString()}|${everyone.value}`
  week.value = seen.value[key]?.events ?? null
  offered.value = seen.value[key]?.offered ?? []
  loading.value = true
  error.value = ''
  try {
    const s = await loadSchedule(monday.value, 7, everyone.value)
    if (mine === ask) {
      seen.value[key] = { events: s.events, offered: s.offered }
      week.value = s.events
      offered.value = s.offered
    }
  }
  catch (e) { if (mine === ask) error.value = (e as ApiError).message }
  finally { if (mine === ask) loading.value = false }
}
watch([monday, everyone, rev], load, { immediate: true })

const offering = computed(() => !everyone.value && needs.value.length > 0)
const shown = computed(() => (week.value ?? []).filter(e => !everyone.value || e.people.some(p => !hidden.value.includes(p.id))))
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60

// the hours shown: a working day, stretched to fit anything booked or offered outside it
const span = computed(() => {
  const all = [...shown.value, ...(offering.value ? [...offered.value, ...weekDrafts.value.map(d => ({ startsAt: d.startsAt, durationMin: lenOf(d.runIds) }))] : [])]
  const starts = all.map(e => hourOf(new Date(e.startsAt)))
  const ends = all.map(e => hourOf(new Date(e.startsAt)) + e.durationMin / 60)
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
  const out = offering.value ? offered.value.filter(o => sameDay(new Date(o.startsAt), d)) : []
  const mine = offering.value ? weekDrafts.value.filter(x => sameDay(new Date(x.startsAt), d)) : []
  const busy = !!(placed.length || out.length || mine.length)
  return { d, weekend: !(d.getDay() % 6), today: sameDay(d, today), lanes: Math.max(1, ends.length), placed, out, mine, busy }
}))
const grid = computed(() => `68px ${columns.value.map(c => c.weekend && !c.busy && !offering.value ? 'minmax(0, 0.45fr)' : 'minmax(0, 1fr)').join(' ')}`)
const top = (iso: string) => `calc(var(--hr) * ${hourOf(new Date(iso)) - span.value.from})`
const now = ref(new Date())
const timer = setInterval(() => (now.value = new Date()), 60_000)
onBeforeUnmount(() => clearInterval(timer))

const range = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const head = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })
const title = computed(() => `${range.format(days.value[0])} – ${range.format(days.value[6])}`)
const initials2 = (e: Booked) => e.people.map(p => initials(p.name)).join(' ')

// ---- jump to a date: the browser's own picker ----
const goto = ref<HTMLInputElement>()
function openPicker() {
  try { goto.value?.showPicker() }
  catch { goto.value?.focus() }
}
function jump(v: string) {
  if (!v) return
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(y!, m! - 1, d!)
  const mon = addDays(t, -((t.getDay() + 6) % 7))
  const thisMon = addDays(today, -((today.getDay() + 6) % 7))
  offset.value = Math.round((mon.getTime() - thisMon.getTime()) / (7 * 86_400_000))
}

// ---- offering times ----
const person = (runId: string) => needs.value.find(n => n.runId === runId)
const first = (runId: string) => person(runId)?.candidateName.split(' ')[0] ?? 'them'
const names = (ids: string[]) => listJoin(ids.map(first))
const lenOf = (runIds: string[]) => Math.max(15, ...runIds.map(id => person(id)?.durationMin ?? 0))
const weekDrafts = computed(() => drafts.value.filter(d => days.value.some(x => sameDay(new Date(d.startsAt), x))))
const moving = ref<Draft | null>(null)
const who = computed(() => dragging.value ?? (moving.value ? null : current.value)) // the person a drop or click is for
const LEAD_MS = 60 * 60_000 // the server's: an offered time starts at least an hour ahead
let nextId = Date.now()

// what a time from `start` for `min` minutes would run into, in words; '' when it is free
function clash(start: Date, min: number, skip?: Draft) {
  const s = start.getTime()
  const e = s + min * 60_000
  const hit = (at: string, len: number) => new Date(at).getTime() < e && s < new Date(at).getTime() + len * 60_000
  if (s - Date.now() < LEAD_MS) return 'too soon'
  const b = (week.value ?? []).find(x => hit(x.startsAt, x.durationMin))
  if (b) return `clashes with ${b.candidateName}`
  const o = offered.value.find(x => hit(x.startsAt, x.durationMin))
  if (o) return `clashes with the time offered to ${o.candidateName.split(' ')[0]}`
  const d = drafts.value.find(x => x !== skip && hit(x.startsAt, lenOf(x.runIds)))
  return d ? `clashes with ${names(d.runIds)}’s time` : ''
}

// the start line: the pointer's place in 15-minute steps
const line = ref<{ day: string, min: number, top: string, label: string, ok: boolean } | null>(null)
function at(e: MouseEvent, d: Date) {
  const col = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const perMin = col.height / (hours.value.length * 60)
  const min = Math.max(0, Math.min(hours.value.length * 60 - 15, Math.round((e.clientY - col.top) / perMin / 15) * 15)) + span.value.from * 60
  return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, min), min }
}
function track(e: MouseEvent, d: Date) {
  const runs = moving.value ? moving.value.runIds : who.value ? [who.value] : null
  if (!offering.value || !runs) return (line.value = null)
  const { start, min } = at(e, d)
  const len = lenOf(runs)
  const why = clash(start, len, moving.value ?? undefined) || (min + len > span.value.to * 60 ? `runs past ${fmtTime(new Date(2000, 0, 1, span.value.to))}` : '')
  const label = moving.value ? `Moving ${names(runs)}` : first(runs[0]!)
  line.value = { day: d.toDateString(), min, top: `calc(var(--hr) * ${min / 60 - span.value.from})`, ok: !why, label: why ? `${fmtTime(start)} · ${why}` : `${label} · ${fmtTime(start)} – ${fmtTime(new Date(start.getTime() + len * 60_000))}` }
}
function place(e: MouseEvent, d: Date) {
  if (!line.value?.ok) return
  const { start } = at(e, d)
  if (moving.value) {
    moving.value.startsAt = start.toISOString()
    moving.value = null
  }
  else if (who.value) {
    drafts.value.push({ id: nextId++, startsAt: start.toISOString(), runIds: [who.value] })
    current.value = who.value
  }
  line.value = null
}
// dropping a person on a time already placed offers it to them too; whoever picks first takes it
function share(d: Draft) {
  const id = dragging.value ?? current.value
  if (!id || d.runIds.includes(id)) return
  const len = Math.max(lenOf(d.runIds), person(id)?.durationMin ?? 0)
  if (clash(new Date(d.startsAt), len, d)) return
  d.runIds.push(id)
  current.value = id
}
function reuse(o: Offered) {
  if (!current.value || drafts.value.some(d => d.startsAt === o.startsAt && d.runIds.includes(current.value!))) return
  drafts.value.push({ id: nextId++, startsAt: o.startsAt, runIds: [current.value] })
}
function remove(d: Draft, runId?: string) {
  d.runIds = runId ? d.runIds.filter(id => id !== runId) : []
  drafts.value = drafts.value.filter(x => x.runIds.length)
  if (moving.value === d) moving.value = null
}
function dropOn(e: DragEvent, d: Date) {
  const onDraft = (e.target as HTMLElement).closest<HTMLElement>('[data-draft]')
  if (onDraft) share(drafts.value.find(x => x.id === Number(onDraft.dataset.draft))!)
  else {
    track(e, d)
    place(e, d)
  }
  dragging.value = null
  line.value = null
}
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && moving.value) moving.value = null }
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

// ---- the send bar ----
const lines = computed(() => needs.value.map(n => ({ n, ds: drafts.value.filter(d => d.runIds.includes(n.runId)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)) })).filter(x => x.ds.length))
const typed = ref('')
function addTyped() {
  if (!current.value || !typed.value) return
  const start = new Date(typed.value)
  if (clash(start, person(current.value)?.durationMin ?? 30)) return (sendError.value = `${fmtBooked(start)} ${clash(start, person(current.value)?.durationMin ?? 30)}.`)
  drafts.value.push({ id: nextId++, startsAt: start.toISOString(), runIds: [current.value] })
  typed.value = ''
  sendError.value = ''
}
const sending = ref(false)
const sendError = ref('')
const sentSay = ref('')
const ERR: Record<string, string> = {
  time_too_soon: 'a time is less than an hour away',
  time_too_far: 'a time is more than 90 days away',
  times_overlap: 'two of the times overlap',
  time_taken: 'someone on the interview is booked then',
  booking_closed: 'the interview has moved on',
}
async function send() {
  sending.value = true
  sendError.value = ''
  sentSay.value = ''
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const todo = lines.value.map(l => ({ runId: l.n.runId, times: l.ds.map(d => d.startsAt), panel: l.n.others.length > 0 }))
  const res = await Promise.allSettled(todo.map(t => api<{ sent: boolean }>(`/api/runs/${t.runId}/booking/offers`, { method: 'POST', body: { times: t.times, timezone } })))
  const ok = todo.filter((_, i) => res[i]!.status === 'fulfilled')
  const bad = todo.map((t, i) => ({ t, r: res[i]! })).filter(x => x.r.status === 'rejected')
  const sentNames = ok.filter(t => !t.panel).map(t => first(t.runId))
  const panelNames = ok.filter(t => t.panel).map(t => first(t.runId))
  sentSay.value = [sentNames.length && `Sent times to ${listJoin(sentNames)}.`, panelNames.length && `${listJoin(panelNames)}’s times went to the panel first.`].filter(Boolean).join(' ')
  sendError.value = bad.map(({ t, r }) => {
    const err = toApiError((r as PromiseRejectedResult).reason)
    return `${first(t.runId)}’s times didn’t go: ${ERR[err.code] ?? err.message}.`
  }).join(' ')
  const done = new Set(ok.map(t => t.runId))
  drafts.value = drafts.value.map(d => ({ ...d, runIds: d.runIds.filter(id => !done.has(id)) })).filter(d => d.runIds.length)
  if (current.value && done.has(current.value)) current.value = null
  sending.value = false
  if (ok.length) rev.value++
}

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
      <span class="date-btn">
        <button type="button" class="btn btn-sm" title="Go to a date" @click="openPicker"><Icon name="calendar" /><span aria-live="polite">{{ title }}</span></button>
        <input ref="goto" type="date" tabindex="-1" aria-label="Go to a date" @change="jump(($event.target as HTMLInputElement).value)">
      </span>
      <span v-if="loading && !week" class="busy">Loading…</span>
    </header>
    <p v-if="offering" class="say-what" aria-live="polite">
      <template v-if="moving">Click where {{ names(moving.runIds) }}’s {{ fmtTime(moving.startsAt) }} should go. Esc cancels.</template>
      <template v-else-if="current">Click the week to add another {{ person(current)?.durationMin }}-minute time for {{ first(current) }}, or drag someone else in.</template>
      <template v-else>Drag someone from Needs times onto the week. The line shows when the interview would start.</template>
    </p>

    <p v-if="error" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ error }} <button class="btn btn-sm" @click="load"><Icon name="retry" />Retry</button></p>

    <div class="cal" :class="{ loading: loading && !week, offering: offering && (who || moving) }" :style="{ gridTemplateColumns: grid }" :aria-busy="loading" :aria-label="loading && !week ? 'Loading the week' : undefined">
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
        @mousemove="track($event, c.d)" @mouseleave="line = null" @click="place($event, c.d)"
        @dragover.prevent="track($event, c.d)" @dragleave="line = null" @drop.prevent="dropOn($event, c.d)"
      >
        <span v-if="c.today && hourOf(now) >= span.from && hourOf(now) <= span.to" class="now" :style="{ top: top(now.toISOString()) }" aria-hidden="true" />
        <span v-if="line && line.day === c.d.toDateString()" class="scrub" :class="{ no: !line.ok }" :style="{ top: line.top }" aria-hidden="true"><b>{{ line.label }}</b></span>
        <button
          v-for="{ e, lane } in c.placed" :key="e.runId" type="button" class="ev"
          :class="{ past: new Date(e.startsAt).getTime() + e.durationMin * 60_000 < now.getTime(), sel: open?.e.runId === e.runId, short: e.durationMin <= 30 }"
          :style="{ top: top(e.startsAt), height: `calc(var(--hr) * ${e.durationMin / 60} - 3px)`, left: `calc(${(lane / c.lanes) * 100}% + 3px)`, width: `calc(${100 / c.lanes}% - 6px)` }"
          :aria-label="`${e.title}, ${when(e)}${everyone ? `, with ${e.people.map(p => p.name).join(', ')}` : ''}`"
          :aria-expanded="open?.e.runId === e.runId"
          @click.stop="choose(e, $event)" @mousemove.stop="line = null"
        >
          <b>{{ fmtTime(e.startsAt) }} {{ e.candidateName }}</b>
          <span v-if="everyone" class="by">{{ initials2(e) }}</span>
        </button>
        <!-- times on the table: an outline; with someone selected, a click offers it to them too -->
        <button
          v-for="o in c.out" :key="`o${o.runId}${o.startsAt}`" type="button" class="ev out"
          :style="{ top: top(o.startsAt), height: `calc(var(--hr) * ${o.durationMin / 60} - 3px)` }"
          :aria-label="`Offered to ${o.candidateName}, ${fmtBooked(o.startsAt)}${current ? `. Offer it to ${first(current)} too` : ''}`"
          @click.stop="current ? reuse(o) : navigateTo({ path: `/inbox/${o.runId}`, query: route.query })" @mousemove.stop="line = null"
        >
          <b>Offered to {{ o.candidateName.split(' ')[0] }}</b><span>{{ fmtTime(o.startsAt) }} · waiting for a pick</span>
        </button>
        <!-- times being placed: the one magenta thing on the week -->
        <div
          v-for="d in c.mine" :key="d.id" class="ev draft" :class="{ lifted: moving === d }" :data-draft="d.id"
          :style="{ top: top(d.startsAt), height: `calc(var(--hr) * ${lenOf(d.runIds) / 60} - 3px)` }"
          @click.stop @mousemove.stop="line = moving && moving !== d ? line : null"
        >
          <span class="top">
            <b>{{ fmtTime(d.startsAt) }} – {{ fmtTime(new Date(new Date(d.startsAt).getTime() + lenOf(d.runIds) * 60_000)) }}</b>
            <span class="faces"><Avatar v-for="id in d.runIds.slice(0, 3)" :key="id" :name="person(id)?.candidateName" :size="18" /></span>
            <span class="acts">
              <button type="button" class="ia" :aria-pressed="moving === d" :aria-label="moving === d ? 'Cancel the move' : `Move ${names(d.runIds)}’s ${fmtBooked(d.startsAt)}`" :title="moving === d ? 'Cancel the move (Esc)' : 'Move'" @click.stop="moving = moving === d ? null : d"><Icon name="move" :size="14" /></button>
              <button type="button" class="ia" :aria-label="`Remove ${names(d.runIds)}’s ${fmtBooked(d.startsAt)}`" title="Remove" @click.stop="remove(d)"><Icon name="trash" :size="14" /></button>
            </span>
          </span>
          <span class="sub">{{ moving === d ? 'Click the new place' : names(d.runIds) }}</span>
        </div>
      </div>
    </div>
    <p class="foot">{{ offering ? 'Booked interviews are filled; times waiting for a pick are outlines.' : `Shows booked times only. Tasks without a time are in ${everyone ? 'each person’s' : 'your'} Tasks.` }}</p>

    <section v-if="offering" class="tray" aria-label="Times to send">
      <div v-if="!lines.length && !current" class="empty-pick">{{ sentSay || 'No times yet. Drag a person onto the week.' }}</div>
      <template v-else>
        <div class="tray-top">
          <p><b>{{ lines.length ? plural(lines.length, 'person', 'people') : first(current!) }}</b> <span class="muted">{{ plural(drafts.length, 'time') }} on the week</span></p>
          <button class="btn btn-primary btn-lg" :disabled="!lines.length || sending" :aria-busy="sending" @click="send">
            <span v-if="sending" class="spinner" />{{ lines.length === 1 && lines[0]!.n.others.length ? `Ask ${listJoin(lines[0]!.n.others)} to confirm` : `Send times to ${lines.length === 1 ? first(lines[0]!.n.runId) : plural(lines.length, 'person', 'people')}` }}<Icon name="arrow-right" />
          </button>
        </div>
        <div class="lines">
          <div v-for="l in lines" :key="l.n.runId" class="tline">
            <Avatar :name="l.n.candidateName" :size="24" />
            <span class="nm">{{ first(l.n.runId) }}</span>
            <div class="picked">
              <span v-for="d in l.ds" :key="d.id" class="chip">{{ fmtBooked(d.startsAt) }}<span v-if="d.runIds.length > 1" class="faint"> · shared</span><button type="button" :aria-label="`Remove ${first(l.n.runId)} from ${fmtBooked(d.startsAt)}`" @click="remove(d, l.n.runId)"><Icon name="x" :size="12" /></button></span>
            </div>
            <p v-if="l.n.others.length" class="hint">Goes to {{ listJoin(l.n.others) }} first. {{ first(l.n.runId) }} gets only the times you can all make.</p>
            <p v-else-if="l.ds.length === 1" class="hint warn"><Icon name="alert" :size="14" />One time only. Most people need two or three to find one that fits.</p>
          </div>
        </div>
        <!-- without a mouse: type a time for the selected person -->
        <label v-if="current" class="typed">
          <span>Add a time for {{ first(current) }}</span>
          <input v-model="typed" type="datetime-local" step="900">
          <button type="button" class="btn btn-sm" :disabled="!typed" @click="addTyped">Add</button>
        </label>
        <p v-if="sentSay" class="ok-say" role="status">{{ sentSay }}</p>
      </template>
      <p v-if="sendError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ sendError }}</p>
    </section>

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
.cal-wrap > .form-error { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.date-btn { position: relative; margin-left: 4px; }
.date-btn .btn { font-weight: 600; }
/* the native picker opens from the button; the input itself stays out of sight and out of the tab order */
.date-btn input { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
.say-what { margin: -6px 0 12px; font-size: var(--t-sm); color: var(--ink-2); }

.cal {
  --hr: 60px; position: relative; display: grid; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-card); box-shadow: var(--shadow-1); overflow: hidden;
}
.cal.offering .col { cursor: copy; }
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
/* the start line: like the now line, with the time a click or drop would offer */
.scrub { position: absolute; left: 0; right: 0; height: 2px; margin-top: -1px; background: var(--accent); pointer-events: none; z-index: 4; }
.scrub::before { content: ""; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.scrub b { position: absolute; left: 8px; bottom: 5px; padding: 2px 8px; border-radius: var(--r-pill); background: var(--accent); color: #fff; font-size: var(--t-xs); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; box-shadow: 0 1px 2px oklch(0.4 0.15 352 / 0.3); }
.scrub.no, .scrub.no::before, .scrub.no b { background: var(--ink-3); box-shadow: none; }

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
.ev.out, .ev.draft { left: 3px; right: 3px; }
.ev.out { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--line-2); }
.ev.out:hover { box-shadow: inset 0 0 0 1.5px var(--ink-3); background: var(--surface); }
.ev.out span { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ev.draft { background: var(--accent); color: #fff; cursor: default; box-shadow: 0 1px 2px oklch(0.4 0.15 352 / 0.3); z-index: 1; }
.ev.draft:hover { background: var(--accent); }
.ev.draft .top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ev.draft .top b { flex: 1; min-width: 0; }
.ev.draft .sub { color: oklch(1 0 0 / 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.faces { display: inline-flex; gap: 3px; flex: none; }
.faces :deep(.avatar) { background: var(--surface); color: var(--accent-ink); font-size: 7.5px; }
/* move and remove: faded in on hover or focus, not removed, so Tab still reaches them */
.acts { position: absolute; top: 3px; right: 3px; display: inline-flex; gap: 2px; opacity: 0; transition: opacity var(--t-micro) var(--ease); }
.ev.draft:hover .acts, .ev.draft:focus-within .acts, .ev.draft.lifted .acts { opacity: 1; }
.ev.draft:hover .faces, .ev.draft:focus-within .faces, .ev.draft.lifted .faces { opacity: 0; }
.ia { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; display: grid; place-items: center; background: oklch(1 0 0 / 0.18); color: #fff; cursor: pointer; }
.ia:hover { background: oklch(1 0 0 / 0.34); }
.ia:focus-visible { outline: 2px solid #fff; outline-offset: 0; }
/* picked up: the old place is an outline until the new place is clicked */
.ev.draft.lifted { background: var(--surface); color: var(--accent-ink); box-shadow: inset 0 0 0 1.5px var(--accent); }
.ev.draft.lifted .sub { color: var(--accent-ink); }
.ev.draft.lifted .ia { background: var(--accent-tint); color: var(--accent-ink); }
.foot { margin-top: 10px; font-size: var(--t-sm); color: var(--ink-2); }

.tray { display: grid; gap: 10px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.tray-top { display: flex; align-items: center; gap: 12px; }
.tray-top p { margin-right: auto; }
.lines { display: grid; gap: 10px; }
.tline { display: grid; grid-template-columns: 24px auto minmax(0, 1fr); gap: 4px 10px; align-items: center; }
.tline .nm { font-weight: 600; }
.tline .hint { grid-column: 2 / -1; }
.picked { display: flex; flex-wrap: wrap; gap: 6px; }
.picked .chip { height: 28px; padding: 0 4px 0 11px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--ink); font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
.picked .chip button { width: 22px; height: 22px; border: 0; border-radius: 50%; background: none; display: grid; place-items: center; color: var(--ink-3); cursor: pointer; }
.picked .chip button:hover { background: var(--hover); color: var(--ink); }
.hint { display: flex; gap: 6px; align-items: center; font-size: var(--t-sm); color: var(--ink-2); }
.hint.warn { color: var(--warn); }
.typed { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--t-sm); color: var(--ink-2); }
.typed input { height: 30px; padding: 0 8px; border: 1px solid var(--line-2); border-radius: var(--r-field); background: var(--surface); }
.ok-say { font-size: var(--t-sm); color: var(--ok); font-weight: 600; }
.empty-pick { padding: 16px; border-radius: var(--r-panel); border: 1.5px dashed var(--line-2); color: var(--ink-2); font-size: var(--t-sm); text-align: center; }

.pop { position: absolute; z-index: 5; width: 300px; padding: 16px; display: grid; gap: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); box-shadow: var(--shadow-3); animation: rise var(--t-micro) var(--ease); }
.pop h3 { font-size: var(--t-lg); }
.pop dl { margin: 0; display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 4px 10px; font-size: var(--t-sm); }
.pop dt { color: var(--ink-3); }
.pop dd { margin: 0; overflow-wrap: anywhere; }
.pop-act { display: flex; flex-wrap: wrap; gap: 6px; }
@media (prefers-reduced-motion: reduce) { .acts, .ev { transition: none; } }
</style>
