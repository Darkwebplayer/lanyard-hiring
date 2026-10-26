<script setup lang="ts">
import type { TaskRow } from '~/composables/useTasks'

useHead({ title: 'Inbox' })
const { inbox, error, refresh } = useTasks()
const { isManager } = useMe()
const { show } = useToast()
const route = useRoute()
const router = useRouter()
// the layout loads the inbox the first time; coming back to it, refresh
if (inbox.value) refresh()

// what the last scorecard did, said at the top of the page it led to (set by the task page)
const flash = useState<{ at: string, text: string, next?: { to: string, title: string } } | null>('inbox-flash', () => null)

const loading = computed(() => !inbox.value && !error.value)
const mine = computed(() => inbox.value?.mine ?? [])
const view = computed(() => (isManager.value && route.query.list === 'attention' ? 'attention' : 'mine'))
const selected = computed(() => route.params.runId as string | undefined)

// failed and stuck steps are automatic ones: no scorecard to open, so they act inline
const attention = computed(() => [
  { key: 'failed', label: 'Failed', rows: inbox.value?.failed ?? [], inline: true },
  { key: 'blocked', label: 'Blocked', rows: inbox.value?.blocked ?? [], inline: false },
  { key: 'overdue', label: 'Overdue', rows: inbox.value?.overdue ?? [], inline: false },
  { key: 'stuck', label: 'Stalled', rows: inbox.value?.stuck ?? [], inline: true },
].filter(s => s.rows.length))
const attentionCount = computed(() => attention.value.reduce((n, s) => n + s.rows.length, 0))

// documents have no scorecard: their checklist lives on the candidate page
const linkTo = (t: TaskRow) => (t.nodeType === 'request_documents' ? `/candidates/${t.applicationId}` : { path: `/inbox/${t.runId}`, query: route.query })
// the open task stays only if the list switched to also holds it; else back to the list's own start
const setView = (v: string) => {
  const rows = v === 'attention' ? attention.value.flatMap(s => s.rows) : mine.value
  const keep = !!selected.value && rows.some(t => t.runId === selected.value)
  router.replace({ path: keep ? route.path : '/inbox', query: v === 'attention' ? { list: 'attention' } : {} })
}

const retrying = ref<string | null>(null)
const retryError = ref<Record<string, string>>({})
async function retry(t: TaskRow) {
  retrying.value = t.runId
  delete retryError.value[t.runId]
  try {
    await api(`/api/runs/${t.runId}/retry`, { method: 'POST' })
    show(`Trying ${nodeMeta(t.nodeType).noun} again for ${t.candidateName}`)
    await refresh()
  }
  catch (e) {
    retryError.value[t.runId] = (e as ApiError).message
  }
  finally {
    retrying.value = null
  }
}

// j / k anywhere (never while typing), ↑ / ↓ while the list has focus
const list = ref<HTMLElement>()
function onKey(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, select, [contenteditable], dialog')) return
  const arrow = (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !!list.value?.contains(t)
  if (e.key !== 'j' && e.key !== 'k' && !arrow) return
  const links = [...(list.value?.querySelectorAll<HTMLAnchorElement>('a[data-task]') ?? [])]
  if (!links.length) return
  e.preventDefault()
  const i = links.findIndex(a => a.dataset.task === selected.value)
  const step = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1
  const next = links[i < 0 ? 0 : Math.min(Math.max(i + step, 0), links.length - 1)]!
  if (arrow) next.focus()
  next.click()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

watch(selected, async (id) => {
  await nextTick()
  list.value?.querySelector(`a[data-task="${id}"]`)?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div class="inbox">
    <aside ref="list" class="list" aria-label="Tasks" data-tour="tasks">
      <header class="list-head">
        <div class="title-row">
          <h1>Inbox</h1>
          <NuxtLink to="/inbox/hours" class="btn btn-sm btn-quiet hours-link" data-tour="hours" :aria-current="route.path === '/inbox/hours' ? 'page' : undefined"><Icon name="calendar" />Interview availability</NuxtLink>
        </div>
        <div v-if="isManager && (inbox || loading)" class="seg" role="radiogroup" aria-label="Show">
          <label><input type="radio" name="list" :checked="view === 'mine'" @change="setView('mine')"><span>Yours <b v-if="inbox" class="n">{{ mine.length }}</b></span></label>
          <label><input type="radio" name="list" :checked="view === 'attention'" @change="setView('attention')"><span>Needs attention <b v-if="attentionCount" class="n n-bad">{{ attentionCount }}</b></span></label>
        </div>
      </header>

      <div v-if="loading" class="rows" aria-busy="true" aria-label="Loading tasks">
        <div v-for="i in 6" :key="i" class="sk-row">
          <span class="skeleton" style="width:32px;height:32px;border-radius:50%" />
          <span class="skeleton" :style="{ height: '14px', width: `${60 + (i * 13) % 30}%` }" />
          <span class="skeleton" style="height:12px;width:45%;grid-column:2" />
        </div>
      </div>


      <template v-else-if="inbox && view === 'mine'">
        <section aria-labelledby="sec-mine">
          <h2 id="sec-mine" class="sec" :class="{ 'sr-only': isManager }">Your tasks <span class="faint">{{ mine.length }}</span></h2>
          <ul v-if="mine.length" class="rows">
            <li v-for="t in mine" :key="t.runId"><InboxTaskRow :task="t" :to="linkTo(t)" :current="t.runId === selected" /></li>
          </ul>
        </section>
        <section v-if="inbox.calledOff?.length" aria-labelledby="sec-off">
          <h2 id="sec-off" class="sec">Cancelled interviews <span class="faint">{{ inbox.calledOff.length }}</span></h2>
          <ul class="rows">
            <li v-for="t in inbox.calledOff" :key="t.runId"><InboxTaskRow :task="t" :to="`/candidates/${t.applicationId}`" :current="false" /></li>
          </ul>
        </section>
      </template>

      <template v-else-if="inbox">
        <p v-if="!attention.length" class="calm"><Icon name="check" :size="16" />Nothing needs attention. No step is stopped, stuck, blocked or late.</p>
        <section v-for="s in attention" :key="s.key" :aria-labelledby="`sec-${s.key}`">
          <h2 :id="`sec-${s.key}`" class="sec">{{ s.label }} <span class="faint">{{ s.rows.length }}</span></h2>
          <ul class="rows">
            <li v-for="t in s.rows" :key="t.runId">
              <div v-if="s.inline" class="problem">
                <Avatar :name="t.candidateName" :size="32" class="av" />
                <div class="p-txt">
                  <p class="p-what">
                    <Icon name="stop" :size="14" />{{ s.key === 'stuck' ? 'Hasn’t moved for a while' : runErrorText(t.error).what }}
                  </p>
                  <p class="p-sub">
                    <NuxtLink :to="`/candidates/${t.applicationId}`">{{ t.candidateName }}</NuxtLink>
                    for {{ t.jobTitle }}
                  </p>
                  <p class="p-fix faint">{{ s.key === 'stuck' ? 'Retry to start this step again. If it stops again, move them on from their page.' : runErrorText(t.error).fix }}</p>
                  <div class="p-act">
                    <button class="btn btn-sm" :aria-busy="retrying === t.runId" :disabled="!!retrying" @click="retry(t)">
                      <span v-if="retrying === t.runId" class="spinner" /><Icon v-else name="retry" />Retry
                    </button>
                    <NuxtLink class="btn btn-sm btn-quiet" :to="`/candidates/${t.applicationId}`"><Icon name="move" />Move on the candidate page</NuxtLink>
                  </div>
                  <p v-if="retryError[t.runId]" class="error" role="alert"><Icon name="alert" :size="14" />{{ retryError[t.runId] }}</p>
                </div>
              </div>
              <template v-else>
                <InboxTaskRow :task="t" :to="linkTo(t)" :current="t.runId === selected" />
                <p v-if="s.key === 'blocked'" class="fix-link"><Icon name="alert" :size="14" />Too few people left to finish it. <NuxtLink :to="`/candidates/${t.applicationId}`">Reassign on the candidate page</NuxtLink></p>
              </template>
            </li>
          </ul>
        </section>
      </template>

      <footer v-if="inbox && (view === 'mine' ? mine.length : attention.length) > 1" class="list-foot faint">
        <span class="kbd">j</span><span class="kbd">k</span> next and previous task
      </footer>
    </aside>

    <section class="detail" data-tour="task">
      <p class="said" aria-live="polite"><template v-if="flash && flash.at === route.path">
        <Icon name="check" :size="16" /><span>{{ flash.text }}</span>
        <NuxtLink v-if="flash.next" :to="flash.next.to" class="next">Next: {{ flash.next.title }}<Icon name="arrow-right" :size="14" /></NuxtLink>
      </template></p>
      <NuxtPage />
    </section>
  </div>
</template>

<style scoped>
.inbox { display: grid; grid-template-columns: clamp(360px, 28vw, 420px) minmax(0, 1fr); min-height: 100dvh; }

.list {
  position: sticky; top: 0; height: 100dvh; overflow-y: auto; display: flex; flex-direction: column;
  border-right: 1px solid var(--line); padding: 0 12px; scrollbar-gutter: stable;
}
.list-head { position: sticky; top: 0; z-index: 1; display: grid; gap: 14px; padding: 28px 8px 14px; background: var(--bg); }
.list-head .seg { justify-self: start; }
.title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hours-link { margin-right: -8px; }
.hours-link[aria-current] { --b-bg: var(--accent-tint); color: var(--accent-ink); }
.n { font-weight: 600; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.n-bad { color: var(--bad); }
.sec { display: flex; gap: 8px; align-items: baseline; margin: 16px 8px 6px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); letter-spacing: 0; }
section:first-of-type .sec:not(.sr-only) { margin-top: 2px; }
.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.sk-row { display: grid; grid-template-columns: 32px 1fr; gap: 8px 12px; align-items: center; padding: 12px; }
.calm { display: flex; gap: 8px; align-items: center; padding: 12px 8px; color: var(--ink-2); }
.calm svg { color: var(--ok); }

.problem { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 12px; border-radius: var(--r-panel); }
.av { margin-top: 2px; }
.p-txt { display: grid; gap: 2px; min-width: 0; }
.p-what { display: flex; gap: 6px; align-items: flex-start; font-weight: 600; color: var(--bad); }
.p-what svg { margin-top: 3px; flex: none; }
.p-sub { color: var(--ink-2); font-size: var(--t-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p-sub a { font-weight: 600; }
.p-fix { font-size: var(--t-sm); }
.p-act { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; margin-left: -2px; }
.problem .error { font-size: var(--t-sm); color: var(--bad); font-weight: 500; display: flex; gap: 6px; margin-top: 6px; }
.fix-link { margin: -6px 12px 8px 56px; font-size: var(--t-sm); color: var(--ink-2); }
.fix-link svg { display: inline; vertical-align: -2px; margin-right: 4px; color: var(--warn); }
.fix-link a { font-weight: 600; }

.list-foot { position: sticky; bottom: 0; margin-top: auto; display: flex; gap: 6px; align-items: center; padding: 14px 8px 18px; background: linear-gradient(transparent, var(--bg) 35%); font-size: var(--t-sm); }

.detail { min-width: 0; padding: 28px clamp(20px, 3vw, 48px) 64px; }
.detail > * { max-width: 820px; }
.said { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; margin-bottom: 16px; padding: 10px 16px; border-radius: var(--r-panel); background: var(--ok-tint); color: var(--ok); font-weight: 600; }
.said:empty { display: block; padding: 0; margin: 0; }
.said .next { display: inline-flex; gap: 4px; align-items: center; margin-left: auto; color: var(--ink); font-weight: 600; }
</style>
