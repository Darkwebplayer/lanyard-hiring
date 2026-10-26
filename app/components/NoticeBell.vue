<script setup lang="ts">
// Updates: the bell in the top-right corner, left of Ask, and its tray. Only urgent and important items count;
// the badge slot on each row says which (red stopped, magenta counted, grey listed only). Mounted once, in the default layout.
const { count, list, error, start, load, open, dismiss, clear } = useNotices()
const tray = ref<HTMLElement>()
const filter = ref<Notice['cat'] | 'all'>('all')
const seen = ref(0) // where the last look ended: rows after it are New

let stop: (() => void) | undefined
onMounted(() => (stop = start()))
onBeforeUnmount(() => stop?.())

const CATS = [['problems', 'Problems'], ['candidates', 'Candidates'], ['tasks', 'Tasks'], ['offers', 'Offers']] as const
const cats = computed(() => CATS.filter(([c]) => list.value?.items.some(i => i.cat === c)))
const problems = computed(() => list.value?.items.filter(i => i.cat === 'problems' && i.tier !== 'fyi').length ?? 0)
const shown = computed(() => (list.value?.items ?? []).filter(i => filter.value === 'all' || i.cat === filter.value))
const RANK = { urgent: 3, important: 2, fyi: 1 }
const isNew = (n: Notice) => n.seq > seen.value && !n.read
const groups = computed(() => [
  // what stopped comes first among the new; the rest by time
  { label: 'New', rows: shown.value.filter(isNew).sort((a, b) => RANK[b.tier] - RANK[a.tier] || b.seq - a.seq) },
  { label: 'Earlier', rows: shown.value.filter(n => !isNew(n)) },
].filter(g => g.rows.length))
const badge = computed(() => (count.value.unread > 99 ? '99+' : String(count.value.unread)))

async function onToggle(e: ToggleEvent) {
  if (e.newState !== 'open') return
  filter.value = 'all'
  await load()
  seen.value = list.value?.seenSeq ?? 0
}
function go(n: Notice) {
  open(n)
  tray.value?.hidePopover()
}
// a filter emptied by a dismiss falls back to All
watch(cats, (c) => { if (filter.value !== 'all' && !c.some(([k]) => k === filter.value)) filter.value = 'all' })
</script>

<template>
  <button
    type="button" class="btn btn-sm bell" popovertarget="updates"
    :aria-label="count.unread ? `Updates, ${badge} new` : 'Updates'" title="Updates"
  >
    <Icon name="bell" :size="16" />
    <b v-if="count.unread" class="count" :class="{ bad: count.urgent }" aria-hidden="true">{{ badge }}</b>
  </button>

  <div id="updates" ref="tray" popover class="tray" role="dialog" aria-labelledby="updates-h" @toggle="onToggle">
    <header class="head">
      <h2 id="updates-h">Updates</h2>
      <button v-if="list?.items.length" type="button" class="btn btn-quiet btn-sm" @click="clear">Clear all</button>
    </header>
    <div v-if="cats.length > 1" class="filter">
      <div class="seg" role="radiogroup" aria-label="Show">
        <label><input v-model="filter" type="radio" name="updates-filter" value="all"><span>All</span></label>
        <label v-for="[c, label] in cats" :key="c">
          <input v-model="filter" type="radio" name="updates-filter" :value="c">
          <span>{{ label }}<b v-if="c === 'problems' && problems" class="n-bad">{{ problems }}</b></span>
        </label>
      </div>
    </div>

    <div class="body">
      <p v-if="error" class="calm">
        <b>Updates didn’t load</b><span>{{ error.message }}</span>
        <button type="button" class="btn btn-sm" @click="load">Try again</button>
      </p>
      <ul v-else-if="!list" class="list" aria-label="Loading">
        <li v-for="i in 4" :key="i" class="sk"><i class="skeleton" /><span><i class="skeleton" /><i class="skeleton" /></span></li>
      </ul>
      <p v-else-if="!list.items.length" class="calm">
        <span class="tick"><Icon name="check" :size="18" /></span>
        <b>You’re up to date</b><span>Stopped steps, offers and interviewers who pass show up here.</span>
      </p>
      <template v-else>
        <section v-for="g in groups" :key="g.label" :aria-label="g.label">
          <h3 class="when">{{ g.label }}</h3>
          <ul class="list">
            <li v-for="n in g.rows" :key="n.seq" class="row" :class="[n.tier, { read: !isNew(n) }]">
              <span class="slot" aria-hidden="true" />
              <NuxtLink :to="n.to" class="what" @click="go(n)">
                <span class="text">{{ n.text }}</span>
                <span class="meta"><b v-if="n.tier === 'urgent'" class="stop">Stopped</b>{{ fmtAgo(n.at) }}</span>
              </NuxtLink>
              <button type="button" class="x" aria-label="Dismiss" title="Dismiss" @click="dismiss(n)"><Icon name="x" :size="14" /></button>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bell { position: relative; width: var(--h-sm); padding: 0; anchor-name: --updates; box-shadow: inset 0 0 0 1px var(--line-2), var(--shadow-1); }
.bell:has(+ .tray:popover-open) { color: var(--accent-ink); box-shadow: inset 0 0 0 1px var(--accent-line), var(--shadow-1); }
/* the rail's count bubble, so the number reads the same everywhere; red only while a step has stopped */
.count {
  position: absolute; top: -5px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: var(--accent); color: #fff; font: 600 10.5px/18px var(--font); text-align: center; box-shadow: 0 0 0 2px var(--bg);
  font-variant-numeric: tabular-nums;
}
.count.bad { background: var(--bad); }

.tray {
  position-anchor: --updates; inset: auto; top: anchor(bottom); right: anchor(right); margin: 8px 0 0;
  width: min(420px, calc(100vw - 32px)); max-height: min(600px, calc(100dvh - 72px)); padding: 0;
  display: none; grid-template-rows: auto auto minmax(0, 1fr);
  border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--surface); color: var(--ink); box-shadow: var(--shadow-3);
  transform-origin: top right;
}
.tray:popover-open { display: grid; animation: tray-in var(--t-move) var(--ease); }
@keyframes tray-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
@media (prefers-reduced-motion: reduce) { .tray:popover-open { animation: none; } }
.head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 10px 18px; }
.head h2 { font-size: var(--t-lg); margin-right: auto; }
.filter { padding: 0 14px 10px; border-bottom: 1px solid var(--line); }
.seg span { height: 28px; padding: 0 11px; }
.n-bad { color: var(--bad); font-variant-numeric: tabular-nums; }
.body { overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 8px; }
.when { padding: 12px 18px 4px; font-size: var(--t-xs); font-weight: 600; color: var(--ink-3); }
.list { list-style: none; margin: 0; padding: 0; }

/* a row: the badge slot (who acts, as everywhere in Lanyard), the sentence, when; x on hover or focus */
.row { display: grid; grid-template-columns: 5px minmax(0, 1fr) auto; gap: 12px; align-items: start; margin: 0 6px; padding: 10px 8px 10px 12px; border-radius: 10px; }
.row:hover, .row:focus-within { background: var(--hover); }
.slot { height: 30px; margin-top: 2px; border-radius: 3px; background: var(--line-2); }
.row.important .slot { background: var(--accent); }
.row.urgent .slot { background: var(--bad); }
.row.read .slot { background: var(--line); }
.what { display: grid; gap: 2px; color: var(--ink); text-decoration: none; }
.what:focus-visible { outline: none; }
.row:has(.what:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
.row.fyi .text, .row.read .text { color: var(--ink-2); }
.meta { display: flex; gap: 6px; font-size: var(--t-xs); color: var(--ink-3); }
.stop { color: var(--bad); font-weight: 600; }
.x { width: 26px; height: 26px; margin: -2px -2px 0 0; display: grid; place-items: center; border: 0; border-radius: 50%; background: none; color: var(--ink-3); cursor: pointer; opacity: 0; transition: opacity var(--t-micro) var(--ease); }
.row:hover .x, .row:focus-within .x { opacity: 1; }
.x:hover { background: var(--surface); color: var(--ink); }

.calm { display: grid; justify-items: center; gap: 6px; padding: 40px 24px 44px; text-align: center; color: var(--ink-2); }
.calm b { color: var(--ink); font-weight: 600; }
.tick { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--ok-tint); color: var(--ok); }
.sk { display: grid; grid-template-columns: 5px 1fr; gap: 12px; margin: 0 6px; padding: 12px 8px 12px 12px; }
.sk > i { height: 30px; }
.sk span { display: grid; gap: 8px; }
.sk span i { height: 10px; }
.sk span i:last-child { width: 40%; }
</style>
