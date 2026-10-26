<script setup lang="ts">
import { addDays, type Booked, loadSchedule } from '~/composables/useTasks'

// Your next 7 days, beside "Take it": what's booked, and the day the task is due.
const props = defineProps<{ dueAt: string | null }>()

const today = addDays(new Date())
const days = Array.from({ length: 7 }, (_, i) => addDays(today, i))
const events = ref<Booked[] | null>(null)
const failed = ref(false)
loadSchedule(today, 7).then(s => (events.value = s.events)).catch(() => (failed.value = true))

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
const on = (d: Date) => events.value?.filter(e => sameDay(new Date(e.startsAt), d)) ?? []
const due = computed(() => props.dueAt ? new Date(props.dueAt) : null)
const first = (name: string) => { const [f, l] = name.split(' '); return l ? `${f} ${l[0]}.` : f }

// one plain sentence: the free weekdays before it's due
const say = computed(() => {
  if (!events.value) return ''
  const before = days.filter(d => d.getDay() % 6 && (!due.value || d <= addDays(due.value)))
  const free = before.filter(d => !on(d).length)
  const n = events.value.length
  const booked = n ? `${plural(n, 'interview')} booked this week.` : 'Nothing booked this week.'
  if (!due.value) return booked
  return `${booked} ${free.length ? `${plural(free.length, 'free weekday')} before it’s due.` : 'No free weekday before it’s due.'}`
})
</script>

<template>
  <div class="strip">
    <div class="days" :aria-busy="!events && !failed">
      <div
        v-for="(d, i) in days" :key="i" class="day"
        :class="{ today: i === 0, off: !(d.getDay() % 6), due: due && sameDay(d, due) }"
      >
        <b>{{ weekday.format(d) }}<i v-if="on(d).length">{{ on(d).length }}</i></b>
        <ul>
          <li v-for="e in on(d)" :key="e.runId" :title="`${e.title}, ${fmtTime(e.startsAt)}`">{{ fmtTime(e.startsAt) }}<small>{{ first(e.candidateName) }}</small></li>
        </ul>
        <span v-if="due && sameDay(d, due)" class="due-tag">Due</span>
      </div>
    </div>
    <p v-if="failed" class="say">Your week didn’t load. You can still take the task.</p>
    <p v-else-if="say" class="say">{{ say }}</p>
  </div>
</template>

<style scoped>
.days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
.day { display: grid; grid-template-rows: auto 1fr auto; gap: 6px; min-height: 104px; padding: 8px; border-radius: 12px; background: var(--sunk); }
.day b { display: flex; justify-content: space-between; font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); }
.day b i { font-style: normal; font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.day.today { background: var(--surface); box-shadow: inset 0 0 0 1px var(--accent-line); }
.day.today b { color: var(--accent-ink); }
/* weekends: hatched, most shops don't interview then */
.day.off { background: repeating-linear-gradient(135deg, var(--sunk) 0 6px, var(--bg) 6px 12px); }
.day.due { box-shadow: inset 0 0 0 1.5px var(--warn); }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; align-content: start; }
li { padding: 3px 6px; border-radius: 6px; background: var(--accent-tint); color: var(--accent-ink); font-size: var(--t-xs); font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; overflow: hidden; }
li small { display: block; font-weight: 400; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: var(--t-xs); }
.due-tag { font-size: var(--t-xs); font-weight: 600; color: var(--warn); }
.say { margin-top: 8px; font-size: var(--t-sm); color: var(--ink-2); }
</style>
