<script setup lang="ts">
import { addDays, type Booked, loadSchedule, type Schedule } from '~/composables/useTasks'

// The list column of Schedule. Mine: what's booked from today, day by day, then who still has to pick a time.
// Everyone (managers): the team, with how many interviews each has in the week the calendar shows.
const route = useRoute()
const router = useRouter()
const { me, isManager } = useMe()
const everyone = computed(() => isManager.value && route.query.who === 'everyone')
const selected = computed(() => route.params.runId as string | undefined)
const setWho = (who: 'mine' | 'everyone') => router.replace({ path: '/inbox', query: { list: 'schedule', ...(who === 'everyone' && { who }) } })

// mine: six weeks ahead is plenty for a small team; past interviews move to Done once the scorecard is in
const today = addDays(new Date())
const mine = ref<Schedule | null>(null)
const error = ref('')
async function load() {
  error.value = ''
  try { mine.value = await loadSchedule(today, 42) }
  catch (e) { error.value = (e as ApiError).message }
}
load()

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

// your interview hours, in one line: "Mon–Fri, 9:00–17:00", or the days when they differ
interface Availability { timezone: string | null, hours: Partial<Record<string, [string, string][]>> }
const hours = ref<string | null>(null)
api<Availability>('/api/me/availability').then((a) => {
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const on = keys.map((k, i) => ({ i, r: (a.hours[k] ?? []).map(x => x.join('–')).join(', ') })).filter(d => d.r)
  if (!a.timezone || !on.length) return (hours.value = 'Not set, so nobody can book you')
  const run = on.every((d, j) => d.r === on[0]!.r && d.i === on[0]!.i + j)
  hours.value = run ? `${names[on[0]!.i]}${on.length > 1 ? `–${names[on.at(-1)!.i]}` : ''}, ${on[0]!.r}` : on.map(d => names[d.i]).join(', ')
}).catch(() => {})

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
        <p v-if="!days.length && !mine.waiting.length" class="calm">Nothing booked. Interviews you take show here once the candidate picks a time.</p>
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
        <section v-if="mine.waiting.length" aria-labelledby="sec-wait">
          <h2 id="sec-wait" class="sec">Waiting to book <span class="faint">{{ mine.waiting.length }}</span></h2>
          <ul class="rows">
            <li v-for="t in mine.waiting" :key="t.runId"><InboxTaskRow :task="t" :to="link(t.runId)" :current="t.runId === selected" /></li>
          </ul>
        </section>
      </template>
      <p class="hours"><span><b>Interview hours</b> <span class="muted">{{ hours ?? '' }}</span></span><NuxtLink to="/inbox/hours">Change</NuxtLink></p>
    </template>
  </div>
</template>

<style scoped>
.sched { display: grid; align-content: start; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 8px 6px; }
.cal-btn[aria-current] { --b-bg: var(--accent-tint); --b-ring: transparent; color: var(--accent-ink); }
.sec { display: flex; gap: 8px; align-items: baseline; margin: 16px 8px 6px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.sec.today { color: var(--accent-ink); }
.rows, .people { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 8px; color: var(--ink-2); }

.slot { position: relative; display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 0 12px; align-items: baseline; padding: 10px 12px; border-radius: var(--r-panel); color: var(--ink); text-decoration: none; transition: background var(--t-micro) var(--ease); }
.slot:hover { background: var(--hover); }
.slot time { grid-row: span 2; font-weight: 600; font-variant-numeric: tabular-nums; }
.slot time small { display: block; font-weight: 500; font-size: var(--t-xs); color: var(--ink-3); }
.slot .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot .s { grid-column: 2 / -1; font-size: var(--t-sm); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot.current { background: var(--accent-tint); }
.slot.current::before { content: ""; position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 4px; height: 22px; border-radius: 4px; background: var(--accent); }

.people label { display: grid; grid-template-columns: 18px 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 12px; border-radius: var(--r-panel); cursor: pointer; }
.people label:hover { background: var(--hover); }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm .faint { font-weight: 400; }
.ct { font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; }

.hours { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 20px 8px 0; padding: 12px 14px; border-radius: var(--r-panel); background: var(--surface); border: 1px solid var(--line); font-size: var(--t-sm); }
.hours a { font-weight: 600; text-decoration: none; }
</style>
