<script setup lang="ts">
import type { Component } from 'vue'

// Help: how the page you're on works, beside it. Shares the dock with Ask (the layout keeps one open at a time).
// Drawn in the accent, the colour for people: help is for the person, Ask is the system answering.
const { canAsk } = useMe()
const { open, topic } = useHelp()
const { open: asking, floats } = useAsk()
const route = useRoute()

const TITLES = {
  inbox: 'Inbox', hours: 'Interview availability', jobs: 'Jobs', pipeline: 'Pipeline', stages: 'Workflow', form: 'Application form', details: 'Job details',
  candidate: 'Candidate', library: 'Templates', team: 'Team', settings: 'Settings', hires: 'Reports', import: 'Import', applicants: 'What candidates see', ai: 'AI', updates: 'Updates', words: 'Glossary',
} as const
type Topic = keyof typeof TITLES

// route name → topic; the library's flow editor is the same stage list as a job's, so it gets the same help
const PAGE: Record<string, Topic> = {
  'inbox': 'inbox', 'inbox-runId': 'inbox', 'tasks-runId': 'inbox', 'inbox-hours': 'hours',
  'jobs': 'jobs', 'jobs-id': 'pipeline', 'jobs-id-flow': 'stages', 'jobs-id-form': 'form', 'jobs-id-details': 'details',
  'candidates-id': 'candidate', 'library-flows-id': 'stages', 'library-flows-id-form': 'form',
  'team': 'team', 'settings': 'settings', 'hires': 'hires', 'import-id': 'import',
}
const RELATED: Record<Topic, Topic[]> = {
  inbox: ['hours', 'updates'], hours: ['inbox'], updates: ['inbox', 'candidate'], jobs: ['pipeline', 'stages'], pipeline: ['stages', 'candidate'], stages: ['ai'], form: ['stages'],
  details: ['ai'], candidate: ['pipeline', 'ai', 'applicants'], library: ['stages'], team: ['hours'], settings: ['ai', 'applicants'], hires: ['jobs'],
  import: ['pipeline'], applicants: ['candidate', 'settings'], ai: ['details', 'stages'], words: [],
}

const page = computed<Topic>(() => {
  const n = String(route.name ?? '')
  return PAGE[n] ?? (n.startsWith('library') ? 'library' : 'inbox')
})
const current = computed<Topic>(() => (topic.value && topic.value in TITLES ? topic.value as Topic : page.value))
// "This page", its neighbours, whatever "What's this?" asked for, and Words last
const chips = computed(() => [...new Set<Topic>([page.value, ...RELATED[page.value], current.value, 'words'])]
  .map(id => ({ id, label: id === page.value ? 'This page' : TITLES[id] })))
const pick = (id: Topic) => { topic.value = id === page.value ? null : id }

// one file per topic in ./help, loaded the first time it is shown
const files = import.meta.glob<{ default: Component }>('./help/*.vue')
const views = Object.fromEntries((Object.keys(TITLES) as Topic[]).map(t =>
  [t, defineAsyncComponent(files[`./help/${t[0]!.toUpperCase()}${t.slice(1)}.vue`]!)]))

// a new page means its own help; an explicit topic belongs to the page it was asked on
const body = ref<HTMLElement>()
watch(() => route.path, () => { topic.value = null })
watch(current, () => { if (body.value) body.value.scrollTop = 0 })

const panel = ref<HTMLElement>()
const mac = ref(true)
let returnTo: HTMLElement | null = null
watch(open, async (o) => {
  if (o) {
    returnTo = document.activeElement as HTMLElement | null
    await nextTick()
    panel.value?.querySelector<HTMLElement>('h2')?.focus()
  }
  else {
    await nextTick()
    if (useAsk().open.value) return // closed because Ask opened: Ask takes the focus
    ;(returnTo?.isConnected ? returnTo : document.querySelector<HTMLElement>('[data-tour="help"]'))?.focus()
  }
})

// ? toggles help anywhere, except while typing or with a modifier (Shift is how ? is typed)
function onKey(e: KeyboardEvent) {
  if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable], dialog')) return
  e.preventDefault()
  if (open.value) open.value = false
  else { topic.value = null; open.value = true }
}
onMounted(() => {
  mac.value = /Mac|iPhone|iPad/.test(navigator.platform)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <aside v-if="open" ref="panel" class="help-panel" :class="{ over: floats }" aria-labelledby="help-h" @keydown.esc.stop="open = false">
    <header class="head">
      <div class="title">
        <h2 id="help-h" tabindex="-1">Help</h2><span class="kbd" aria-hidden="true">?</span>
      </div>
      <button type="button" class="btn btn-quiet btn-icon btn-sm close" aria-label="Close help" title="Close (Esc or ?)" @click="open = false">
        <Icon name="x" :size="16" />
      </button>
      <div class="topics" role="group" aria-label="Topics">
        <button v-for="c in chips" :key="c.id" type="button" class="topic" :aria-pressed="c.id === current" @click="pick(c.id)">{{ c.label }}</button>
      </div>
    </header>

    <div ref="body" class="body">
      <Transition name="turn" mode="out-in">
        <component :is="views[current]" :key="current" />
      </Transition>
    </div>

    <footer v-if="canAsk" class="foot">
      <span class="faint">Still stuck?</span>
      <button type="button" class="btn btn-sm" @click="asking = true">
        <Icon name="ask" :size="14" />Ask Lanyard<span class="kbd">{{ mac ? '⌘J' : 'Ctrl J' }}</span>
      </button>
    </footer>
  </aside>
</template>

<style scoped>
/* docked beside <main> from 1280 px (the shell gives it a column); below that, and on the canvas pages, it lies over the right edge */
.help-panel {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 30; width: 392px;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--surface); border-left: 1px solid var(--line); box-shadow: var(--shadow-3);
}
@media (min-width: 1280px) {
  .help-panel:not(.over) { position: sticky; bottom: auto; align-self: start; height: 100dvh; width: auto; box-shadow: -16px 0 32px -24px oklch(0.3 0.04 330 / 0.25); }
}
.help-panel { animation: ask-in var(--t-move) var(--ease); }
@keyframes ask-in { from { opacity: 0; translate: 16px 0; } }
/* the badge slot: accent, because help is for people */
.help-panel::before { content: ""; position: absolute; top: 9px; left: 50%; translate: -50% 0; width: 30px; height: 5px; border-radius: 9px; background: var(--accent); }

.head { position: relative; padding: 24px 18px 14px; display: grid; gap: 12px; border-bottom: 1px solid var(--line); }
.title { display: flex; align-items: center; gap: 8px; min-height: 30px; padding-right: 40px; }
.title h2 { font-size: var(--t-lg); outline: none; }
.close { position: absolute; top: 14px; right: 16px; width: var(--h-sm); }
.topics { display: flex; flex-wrap: wrap; gap: 6px; }
.topic {
  height: 28px; padding: 0 11px; border: 0; border-radius: var(--r-pill); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2);
  font: 600 var(--t-sm) var(--font); color: var(--ink-2); cursor: pointer; transition: background var(--t-micro) var(--ease);
}
.topic:hover { background: var(--hover); color: var(--ink); }
.topic[aria-pressed="true"] { background: var(--ink); color: #fff; box-shadow: none; }

.turn-enter-active { transition: opacity var(--t-move) var(--ease), translate var(--t-move) var(--ease); }
.turn-leave-active { transition: opacity var(--t-micro) ease-in; }
.turn-enter-from { opacity: 0; translate: 0 6px; }
.turn-leave-to { opacity: 0; }

/* the topics' shared words and shapes; each topic file only styles its own diagram */
.body { overflow-y: auto; overscroll-behavior: contain; padding: 20px 18px 28px; }
.body :deep(.topic-body) { display: grid; gap: 14px; align-content: start; color: var(--ink-2); line-height: 1.55; }
.body :deep(h3) { font-size: var(--t-lg); color: var(--ink); line-height: 1.3; }
.body :deep(h4) { font-size: var(--t-md); color: var(--ink); margin-top: 6px; line-height: 1.3; }
.body :deep(b) { color: var(--ink); font-weight: 600; }
.body :deep(ul), .body :deep(ol) { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; }
.body :deep(li::marker) { color: var(--ink-3); }
.body :deep(.dia) { position: relative; display: grid; gap: 6px; padding: 14px; border-radius: var(--r-panel); background: var(--sunk); font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); line-height: 1.35; }
.body :deep(.dia-item) { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: var(--r-field); background: var(--surface); }
.body :deep(.gl) { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; margin: 0; font-size: var(--t-sm); }
.body :deep(.gl dt) { font-weight: 600; color: var(--ink); }
.body :deep(.gl dd) { margin: 0; }
.body :deep(.go) { color: var(--accent-ink); font-weight: 600; }

.foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line); font-size: var(--t-sm); }
.foot .kbd { margin-left: 2px; }
</style>
