<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import type { TaskRow } from '~/composables/useTasks'

defineProps<{ task: TaskRow, to: RouteLocationRaw, current: boolean }>()

// up for grabs: who else has it, and how many it still needs when that's more than one
const who = (g: NonNullable<TaskRow['grab']>) => g.need > 1
  ? `Needs ${g.need} people${g.taken.length ? ` · ${g.taken.join(', ')} took it` : ''}`
  : `Also open for ${plural(g.others.length, 'other')}`

// the interview in a few words: what's next, and whether it's yours to do
function said(b: NonNullable<TaskRow['booking']>) {
  if (b.cancelledAt) return `Cancelled: the interview on ${fmtBooked(b.startsAt)}`
  switch (b.stage) {
    case 'declined': return 'Stepped back from the interview'
    case 'needs_times': return b.startsAt ? 'Asked to move the interview' : b.note ? 'Asked for other times' : 'Needs times from you'
    case 'panel': return b.mustAnswer ? `${b.offeredBy} offered ${plural(b.count ?? 0, 'time')}: can you make them?` : `Waiting for ${listJoin(b.pending ?? [])} to confirm`
    case 'candidate': return `${plural(b.count ?? 0, 'time')} sent, waiting for a pick`
  }
  return b.startsAt ? `Interview ${fmtBooked(b.startsAt)}` : 'No time yet'
}
const yourMove = (b: NonNullable<TaskRow['booking']>) => !b.cancelledAt && (b.stage === 'needs_times' || b.stage === 'declined' || !!b.mustAnswer)
</script>

<template>
  <NuxtLink :to="to" class="row" :class="{ current, open: task.grab }" :data-task="task.runId" :aria-current="current ? 'page' : undefined">
    <Avatar :name="task.candidateName" :size="32" class="av" />
    <span class="title">{{ task.title }}</span>
    <span class="job">{{ task.jobTitle }}</span>
    <DueChip :due="task.dueAt" :overdue="task.overdue" class="due" />
    <span v-if="task.booking" class="book" :class="{ waiting: !yourMove(task.booking) && (task.booking.stage ? task.booking.stage !== 'booked' : !task.booking.startsAt), yours: yourMove(task.booking) }">
      <Icon name="calendar" :size="14" />{{ said(task.booking) }}
    </span>
    <span v-if="task.grab" class="who">{{ who(task.grab) }}</span>
  </NuxtLink>
</template>

<style scoped>
.row {
  position: relative; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; grid-template-areas: "av title title" "av job due";
  gap: 2px 12px; align-items: center; padding: 10px 12px; border-radius: var(--r-panel);
  color: var(--ink); text-decoration: none; transition: background var(--t-micro) var(--ease);
}
.row:hover { background: var(--hover); }
.av { grid-area: av; align-self: start; margin-top: 2px; }
.title { grid-area: title; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.job { grid-area: job; color: var(--ink-2); font-size: var(--t-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.due { grid-area: due; }
.book { grid-column: 2 / -1; display: inline-flex; gap: 6px; align-items: center; font-size: var(--t-sm); font-weight: 500; color: var(--ink); }
.book svg { color: var(--accent-ink); flex: none; }
.book.waiting { color: var(--ink-3); font-weight: 400; }
.book.yours { color: var(--accent-ink); font-weight: 600; }
.who { grid-column: 2 / -1; font-size: var(--t-xs); color: var(--ink-3); }
/* up for grabs: nobody holds it yet, so the face is an empty outline */
.row.open .av { background: transparent; box-shadow: inset 0 0 0 1.5px var(--line-2); color: var(--ink-3); }
.row.open.current .av { box-shadow: inset 0 0 0 1.5px var(--accent-line); color: var(--accent-ink); }
.book.waiting svg { color: var(--ink-3); }
/* current: the accent tint plus a short accent bar, the slot turned on its side */
.row.current { background: var(--accent-tint); }
.row.current::before { content: ""; position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 4px; height: 22px; border-radius: 4px; background: var(--accent); }
.row.current .job { color: var(--ink-2); }
</style>
