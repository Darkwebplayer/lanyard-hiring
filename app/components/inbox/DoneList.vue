<script setup lang="ts">
import type { DoneRow } from '~/composables/useTasks'

// The list column of Done: what you sent or passed on, newest first, by month.
const route = useRoute()
const { isManager } = useMe()
const selected = computed(() => route.params.runId as string | undefined)

const rows = ref<DoneRow[] | null>(null)
const error = ref('')
async function load() {
  error.value = ''
  try { rows.value = await api<DoneRow[]>('/api/tasks/done') }
  catch (e) { error.value = (e as ApiError).message }
}
load()

const q = ref('')
const month = new Intl.DateTimeFormat(undefined, { month: 'long' })
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const groups = computed(() => {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = (rows.value ?? []).filter(r => words.every(w => `${r.candidateName} ${r.jobTitle} ${r.title}`.toLowerCase().includes(w)))
  const by = new Map<string, DoneRow[]>()
  for (const r of hits) {
    const d = new Date(r.doneAt)
    const k = (d.getFullYear() === new Date().getFullYear() ? month : monthYear).format(d)
    by.set(k, [...(by.get(k) ?? []), r])
  }
  return [...by]
})

// the chip: your answer to its yes/no question ("Hire: Yes", or just "Yes" when the question is long), else what happened
const chip = (r: DoneRow) => {
  if (r.passed) return { text: 'Passed', cls: '', title: '' }
  if (!r.answer) return { text: r.nodeType === 'request_documents' ? 'Done' : 'Sent', cls: '', title: '' }
  const label = r.answer.label.replace(/\?$/, '')
  const yes = r.answer.yes ? 'Yes' : 'No'
  return { text: label.length <= 10 ? `${label}: ${yes}` : yes, cls: r.answer.yes ? 'chip-ok' : '', title: `${r.answer.label} ${yes}` }
}
// passed tasks were never yours: only managers can open them
const opens = (r: DoneRow) => !r.passed || isManager.value
const Link = resolveComponent('NuxtLink')
</script>

<template>
  <div class="done">
    <label class="search">
      <Icon name="search" :size="16" />
      <input v-model="q" type="search" placeholder="Find a candidate or job" aria-label="Find a candidate or job">
    </label>

    <div v-if="!rows && !error" class="rows" aria-busy="true" aria-label="Loading what you did">
      <span v-for="i in 5" :key="i" class="skeleton" :style="{ height: '14px', width: `${55 + (i * 11) % 30}%`, margin: '14px 12px' }" />
    </div>
    <p v-else-if="error" class="calm"><Icon name="alert" :size="16" />{{ error }} <button class="btn btn-sm" @click="load"><Icon name="retry" />Retry</button></p>
    <p v-else-if="!rows!.length" class="calm">Nothing here yet. Tasks you send show here, so you can look back at what you said.</p>
    <p v-else-if="!groups.length" class="calm">Nothing matches “{{ q }}”.</p>

    <section v-for="[m, list] in groups" :key="m" :aria-label="m">
      <h2 class="sec">{{ m }} <span class="faint">{{ list.length }}</span></h2>
      <ul class="rows">
        <li v-for="r in list" :key="r.runId">
          <component
            :is="opens(r) ? Link : 'div'" :to="opens(r) ? { path: `/inbox/${r.runId}`, query: route.query } : undefined"
            class="row" :class="{ current: r.runId === selected, passed: r.passed }" :data-task="opens(r) ? r.runId : undefined"
            :aria-current="r.runId === selected ? 'page' : undefined"
          >
            <Avatar :name="r.candidateName" :size="32" class="av" />
            <span class="title">{{ r.title }}</span>
            <time class="when" :datetime="r.doneAt">{{ fmtDate(r.doneAt) }}</time>
            <span class="job">{{ r.jobTitle }}</span>
            <span class="chip" :class="chip(r).cls" :title="chip(r).title || undefined">{{ chip(r).text }}</span>
          </component>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.done { display: grid; align-content: start; }
.search { position: relative; margin: 0 8px 4px; }
.search svg { position: absolute; left: 12px; top: 50%; translate: 0 -50%; color: var(--ink-3); pointer-events: none; }
.search input { padding-left: 36px; }
.sec { display: flex; gap: 8px; align-items: baseline; margin: 16px 8px 6px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.calm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 8px; color: var(--ink-2); }

.row {
  position: relative; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; grid-template-areas: "av title when" "av job chip";
  gap: 2px 12px; align-items: center; padding: 10px 12px; border-radius: var(--r-panel); color: var(--ink); text-decoration: none;
  transition: background var(--t-micro) var(--ease);
}
a.row:hover { background: var(--hover); }
.av { grid-area: av; align-self: start; margin-top: 2px; background: var(--sunk); color: var(--ink-2); }
.title { grid-area: title; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.when { grid-area: when; justify-self: end; font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.job { grid-area: job; color: var(--ink-2); font-size: var(--t-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { grid-area: chip; justify-self: end; }
.row.passed .title { font-weight: 500; color: var(--ink-2); }
.row.current { background: var(--accent-tint); }
.row.current::before { content: ""; position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 4px; height: 22px; border-radius: 4px; background: var(--accent); }
</style>
