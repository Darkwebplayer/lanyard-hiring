<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import type { TaskRow } from '~/composables/useTasks'

defineProps<{ task: TaskRow, to: RouteLocationRaw, current: boolean }>()
// the interview's own time beats the scorecard's due date for planning a day, so it gets the weekday
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
</script>

<template>
  <NuxtLink :to="to" class="row" :class="{ current }" :data-task="task.runId" :aria-current="current ? 'page' : undefined">
    <Avatar :name="task.candidateName" :size="32" class="av" />
    <span class="title">{{ task.title }}</span>
    <span class="job">{{ task.jobTitle }}</span>
    <DueChip :due="task.dueAt" :overdue="task.overdue" class="due" />
    <span v-if="task.booking" class="book" :class="{ waiting: !task.booking.startsAt }">
      <Icon name="calendar" :size="14" />{{ task.booking.startsAt ? `Interview ${when(task.booking.startsAt)}` : 'Waiting for the candidate to book' }}
    </span>
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
.book.waiting svg { color: var(--ink-3); }
/* current: the accent tint plus a short accent bar, the slot turned on its side */
.row.current { background: var(--accent-tint); }
.row.current::before { content: ""; position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 4px; height: 22px; border-radius: 4px; background: var(--accent); }
.row.current .job { color: var(--ink-2); }
</style>
