<script setup lang="ts">
import { addDays, type Booked, loadSchedule, type Schedule, type ToBook, useOffering } from '~/composables/useTasks'

// The list column of Schedule. Mine: who needs times (drag them onto the week), who is waiting on the panel or
// the candidate, then what's booked from today, day by day.
// Everyone (managers): the team, with how many interviews each has in the week the calendar shows.
const route = useRoute()
const router = useRouter()
const { me, isManager } = useMe()
const everyone = computed(() => isManager.value && route.query.who === 'everyone')
const selected = computed(() => route.params.runId as string | undefined)
const setWho = (who: 'mine' | 'everyone') => router.replace({ path: '/inbox', query: { list: 'schedule', ...(who === 'everyone' && { who }) } })
const { needs, drafts, current, dragging, rev } = useOffering()

// mine: six weeks ahead is plenty for a small team; past interviews move to Done once the scorecard is in
const today = addDays(new Date())
const mine = ref<Schedule | null>(null)
const error = ref('')
async function load() {
  error.value = ''
  try {
    mine.value = await loadSchedule(today, 42)
    needs.value = mine.value.needs
    // a person who no longer needs times (sent elsewhere, the step moved on) leaves the week's drafts
    const ids = new Set(needs.value.map(n => n.runId))
    drafts.value = drafts.value.map(d => ({ ...d, runIds: d.runIds.filter(id => ids.has(id)) })).filter(d => d.runIds.length)
    if (current.value && !ids.has(current.value)) current.value = null
  }
  catch (e) { error.value = (e as ApiError).message }
}
load()
watch(rev, load)

const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const days = computed(() => {
  const by = new Map<string, Booked[]>()
  for (const e of mine.value?.events ?? []) {
    const k = addDays(new Date(e.startsAt)).toDateString()
    by.set(k, [...(by.get(k) ?? []), e])
  }
  return [...by].map(([k, events]) => {
    const d = new Date(k)
    const n = Math.round((d.getTime() - today.getTime()) / 86_400_000)
    return { key: k, label: n === 0 ? `Today · ${dayName.format(d)}` : n === 1 ? `Tomorrow · ${dayName.format(d)}` : dayName.format(d), today: n === 0, events }
  })
})
const soon = (iso: string) => {
  const m = (new Date(iso).getTime() - Date.now()) / 60_000
  return m > 0 && m < 12 * 60 ? (m < 60 ? `In ${Math.round(m)} min` : `In ${Math.round(m / 60)} h`) : ''
}
const link = (runId: string) => ({ path: `/inbox/${runId}`, query: route.query })
// back to the week from an opened task; Mine or Everyone and the week shown stay as they were
const calendar = computed(() => ({ path: '/inbox', query: route.query }))

// ---- needs times: drag onto the week, or select and click it ----
const placed = (runId: string) => drafts.value.filter(d => d.runIds.includes(runId)).length
function pick(n: ToBook) {
  current.value = current.value === n.runId ? null : n.runId
  if (selected.value) router.push(calendar.value) // the week is where times go
}
function dragStart(n: ToBook, e: DragEvent) {
  dragging.value = n.runId
  e.dataTransfer?.setData('text/plain', n.candidateName)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}
const panelWith = (n: ToBook) => n.others.length ? `Panel with ${n.others.join(', ')}` : ''

// ---- waiting: on whom, in words ----
function waitLine(n: ToBook) {
  const b = n.booking
  if (b.stage === 'declined') return `${n.candidateName.split(' ')[0]} stepped back from the interview`
  if (b.stage === 'panel') return b.mustAnswer ? `${b.offeredBy} offered ${plural(b.count ?? 0, 'time')}. Can you make them?` : `Waiting for ${b.pending?.join(' and ')} to confirm ${plural(b.count ?? 0, 'time')}`
  return `${plural(b.count ?? 0, 'time')} sent · ${n.candidateName.split(' ')[0]} hasn’t picked yet`
}
const waitChip = (n: ToBook) => n.booking.stage === 'declined' ? 'Stepped back' : n.booking.stage === 'panel' ? (n.booking.mustAnswer ? 'Your turn' : `${n.booking.pending?.[0]}’s turn`) : n.sentAt ? `Sent ${fmtAgo(n.sentAt).replace(/^Yesterday$/, 'yesterday')}` : 'Sent'

// everyone: the team and their load this week (the calendar fills the week's events)
const team = ref<{ id: string, name: string }[] | null>(null)
watch(everyone, (on) => { if (on && !team.value) api<{ id: string, name: string }[]>('/api/users/assignable').then(r => (team.value = r)).catch(() => (team.value = [])) }, { immediate: true })
const week = useState<Booked[] | null>('sched-week', () => null)
const hidden = useState<string[]>('sched-hidden', () => [])
const count = (id: string) => week.value?.filter(e => e.people.some(p => p.id === id)).length ?? 0
const toggle = (id: string, on: boolean) => (hidden.value = on ? hidden.value.filter(h => h !== id) : [...hidden.value, id])
</script>

<template>
  <div class="sched">
    <div class="bar">
      <div v-if="isManager" class="seg" role="radiogroup" aria-label="Whose schedule">
        <label><input type="radio" name="who" :checked="!everyone" @change="setWho('mine')"><span>Mine</span></label>
        <label><input type="radio" name="who" :checked="everyone" @change="setWho('everyone')"><span>Everyone</span></label>
      </div>
      <NuxtLink :to="calendar" class="btn btn-sm cal-btn" :aria-current="!selected ? 'page' : undefined"><Icon name="calendar" />Week calendar</NuxtLink>
    </div>

    <template v-if="everyone">
      <h2 class="sec">Team this week <span v-if="week" class="faint">{{ plural(week.length, 'interview') }}</span></h2>
      <ul v-if="team" class="people">
        <li v-for="p in team" :key="p.id">
          <label>
            <input type="checkbox" :checked="!hidden.includes(p.id)" @change="toggle(p.id, ($event.target as HTMLInputElement).checked)">
            <Avatar :name="p.name" :size="28" />
            <span class="nm">{{ p.name }}<span v-if="p.id === me?.id" class="faint"> (you)</span></span>
            <span class="ct" :class="{ faint: !count(p.id) }">{{ week ? count(p.id) : '' }}</span>
          </label>
        </li>
      </ul>
      <div v-else class="rows" aria-busy="true" aria-label="Loading the team"><span v-for="i in 4" :key="i" class="skeleton" style="height:28px;margin:8px 12px" /></div>
    </template>

    <template v-else>
      <div v-if="!mine && !error" class="rows" aria-busy="true" aria-label="Loading your schedule">
        <span v-for="i in 4" :key="i" class="skeleton" :style="{ height: '14px', width: `${55 + (i * 11) % 30}%`, margin: '14px 12px' }" />
      </div>
      <p v-else-if="error" class="calm"><Icon name="alert" :size="16" />{{ error }} <button class="btn btn-sm" @click="load"><Icon name="retry" />Retry</button></p>
      <template v-else-if="mine">
        <p v-if="!days.length && !mine.needs.length && !mine.waiting.length" class="calm">Nothing booked. When you have an interview, the candidate shows here and you offer them times.</p>

        <section v-if="mine.needs.length" aria-labelledby="sec-need">
          <h2 id="sec-need" class="sec">Needs times <span class="faint">{{ mine.needs.length }}</span></h2>
          <p class="hint">Drag a person onto the week to offer a time. Drag again for another time. Drop on someone’s time to share it.</p>
          <ul class="rows">
            <li v-for="n in mine.needs" :key="n.runId">
              <div
                class="need" :class="{ dragging: dragging === n.runId }" draggable="true" role="button" tabindex="0"
                :aria-pressed="current === n.runId" :aria-label="`${n.candidateName}, ${n.durationMin} minutes. Select, then click the week or add a time below it.`"
                @click="pick(n)" @keydown.enter.prevent="pick(n)" @keydown.space.prevent="pick(n)"
                @dragstart="dragStart(n, $event)" @dragend="dragging = null"
              >
                <Icon name="grip" :size="14" class="grip" />
                <Avatar :name="n.candidateName" :size="32" class="av" />
                <span class="t">{{ n.candidateName }}</span>
                <span class="chip" :class="{ 'chip-accent': placed(n.runId) }">{{ placed(n.runId) ? plural(placed(n.runId), 'time') : `${n.durationMin} min` }}</span>
                <span class="s">{{ [n.jobTitle, panelWith(n), n.booking.startsAt && `Booked ${fmtBooked(n.booking.startsAt)}`].filter(Boolean).join(' · ') }}</span>
                <span v-if="n.booking.note" class="say"><b>{{ n.candidateName.split(' ')[0] }}:</b> “{{ n.booking.note }}”</span>
                <span v-else-if="n.teamNote" class="say">{{ n.teamNote }}</span>
              </div>
            </li>
          </ul>
        </section>

        <section v-if="mine.waiting.length" aria-labelledby="sec-wait">
          <h2 id="sec-wait" class="sec">Waiting <span class="faint">{{ mine.waiting.length }}</span></h2>
          <ul class="rows">
            <li v-for="n in mine.waiting" :key="n.runId">
              <NuxtLink :to="link(n.runId)" class="wait" :class="{ current: n.runId === selected, turn: n.booking.mustAnswer }" :aria-current="n.runId === selected ? 'page' : undefined">
                <Avatar :name="n.candidateName" :size="32" class="av" />
                <span class="t">{{ n.candidateName }}</span>
                <span class="chip" :class="{ 'chip-accent': n.booking.mustAnswer, 'chip-warn': n.booking.stage === 'declined' }">{{ waitChip(n) }}</span>
                <span class="s">{{ waitLine(n) }}</span>
              </NuxtLink>
            </li>
          </ul>
        </section>

        <section v-for="d in days" :key="d.key" :aria-label="d.label">
          <h2 class="sec" :class="{ today: d.today }">{{ d.label }} <span class="faint">{{ d.events.length }}</span></h2>
          <ul class="rows">
            <li v-for="e in d.events" :key="e.runId">
              <NuxtLink :to="link(e.runId)" class="slot" :class="{ current: e.runId === selected }" :data-task="e.runId" :aria-current="e.runId === selected ? 'page' : undefined">
                <time :datetime="e.startsAt">{{ fmtTime(e.startsAt) }}<small>{{ e.durationMin }} min</small></time>
                <span class="t">{{ e.candidateName }}</span>
                <span v-if="soon(e.startsAt)" class="chip chip-accent">{{ soon(e.startsAt) }}</span>
                <span class="s">{{ e.jobTitle }}<template v-if="e.location"> · {{ e.location }}</template></span>
              </NuxtLink>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.sched { display: grid; align-content: start; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 8px 6px; }
.cal-btn[aria-current] { --b-bg: var(--accent-tint); --b-ring: transparent; color: var(--accent-ink); }
.sec { display: flex; gap: 8px; align-items: baseline; margin: 16px 8px 6px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.sec.today { color: var(--accent-ink); }
.hint { margin: -2px 8px 6px; font-size: var(--t-xs); color: var(--ink-3); }
.rows, .people { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 8px; color: var(--ink-2); }

/* a candidate who needs times: drag onto the week, or select (the magenta bar) and click it */
.need, .wait { position: relative; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; padding: 10px 12px; border-radius: var(--r-panel); color: var(--ink); text-decoration: none; transition: background var(--t-micro) var(--ease); }
.need { cursor: grab; }
.need:active { cursor: grabbing; }
.need:hover, .wait:hover { background: var(--hover); }
.need[aria-pressed="true"], .wait.current { background: var(--accent-tint); }
.need[aria-pressed="true"]::before, .wait.current::before { content: ""; position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 4px; height: 22px; border-radius: 4px; background: var(--accent); }
.need.dragging { opacity: 0.45; }
.need .grip { position: absolute; left: -2px; top: 50%; translate: 0 -50%; color: var(--ink-3); opacity: 0; transition: opacity var(--t-micro) var(--ease); }
.need:hover .grip, .need:focus-visible .grip { opacity: 1; }
.need[aria-pressed="true"] .grip { display: none; }
.need .av, .wait .av { grid-row: span 2; align-self: start; margin-top: 2px; }
.t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.need .s, .wait .s { grid-column: 2 / -1; font-size: var(--t-sm); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.say { grid-column: 2 / -1; margin-top: 4px; padding: 6px 10px; border-radius: 10px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); font-size: var(--t-sm); white-space: pre-line; overflow-wrap: anywhere; }
.say b { font-weight: 600; }

.slot { position: relative; display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 0 12px; align-items: baseline; padding: 10px 12px; border-radius: var(--r-panel); color: var(--ink); text-decoration: none; transition: background var(--t-micro) var(--ease); }
.slot:hover { background: var(--hover); }
.slot time { grid-row: span 2; font-weight: 600; font-variant-numeric: tabular-nums; }
.slot time small { display: block; font-weight: 500; font-size: var(--t-xs); color: var(--ink-3); }
.slot .s { grid-column: 2 / -1; font-size: var(--t-sm); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot.current { background: var(--accent-tint); }
.slot.current::before { content: ""; position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 4px; height: 22px; border-radius: 4px; background: var(--accent); }

.people label { display: grid; grid-template-columns: 18px 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 12px; border-radius: var(--r-panel); cursor: pointer; }
.people label:hover { background: var(--hover); }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm .faint { font-weight: 400; }
.ct { font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .need, .wait, .slot, .need .grip { transition: none; } }
</style>
