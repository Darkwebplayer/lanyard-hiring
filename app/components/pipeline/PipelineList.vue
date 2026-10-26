<script setup lang="ts">
import type { Board } from '~/pages/jobs/[id].vue'
import type { Graph } from '~~/shared/workflow/types'
import { type ListRow, type Pos, SCORE_BANDS, boardColumns, inStep, posId, posOfRow } from '~/lib/board'
import BoardMoveDialog, { type Drop, type Part } from './BoardMoveDialog.vue'

const props = defineProps<{ jobId: string, board: Board, graph: Graph | null, nameOf: (id: string) => string | undefined }>()
const emit = defineEmits<{ reload: [] }>()
const route = useRoute()
const router = useRouter()
const { isManager } = useMe()

// ---------- filters live in the URL, so a link to "under 40 in Screening" opens just that ----------
const STATUS = [
  { value: 'active', label: 'Active' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'all', label: 'All candidates' },
] as const
type Show = typeof STATUS[number]['value']
const str = (k: string) => (route.query[k] as string | undefined) ?? ''
const show = computed<Show>(() => STATUS.some(s => s.value === route.query.show) ? route.query.show as Show : 'active')
const q = computed(() => str('q'))
const band = computed(() => SCORE_BANDS.find(b => b.value === str('score')) ?? SCORE_BANDS[0])
const src = computed(() => str('src'))
const setQuery = (patch: Record<string, string | undefined>) => router.replace({ query: { ...route.query, ...patch } })

const columns = computed(() => boardColumns(props.board))
const targets = computed(() => columns.value.flatMap(c => c.rows.map(r => ({ ...r, group: c.name }))))
const label = (pos: Pos | null) => (pos && targets.value.find(t => t.id === posId(pos))?.label) ?? '–'
const stageOf = (key: string | null) => columns.value.find(c => c.id !== 'closed' && c.rows.some(r => 'node' in r.pos && r.pos.node === key))
// one select for where: a whole stage (s:id) or one step (n:key)
const where = computed(() => str('stage') ? `s:${str('stage')}` : str('step') ? `n:${str('step')}` : '')
const whereSteps = computed(() => {
  if (where.value.startsWith('n:')) return [where.value.slice(2)]
  const col = columns.value.find(c => `s:${c.id}` === where.value)
  return col ? col.rows.flatMap(r => 'node' in r.pos ? [r.pos.node] : []) : []
})
function setWhere(v: string) {
  setQuery({ stage: v.startsWith('s:') ? v.slice(2) : undefined, step: v.startsWith('n:') ? v.slice(2) : undefined })
}
const counts = computed(() => props.board.counts)
const countOf = (s: Show) => counts.value.filter(c => s === 'all' || (s === 'active' ? c.status === 'active' : c.outcome === s)).reduce((n, c) => n + c.n, 0)

const filters = computed(() => ({
  show: show.value,
  q: q.value.trim() || undefined,
  step: whereSteps.value.join(',') || undefined,
  minScore: 'min' in band.value ? band.value.min : undefined,
  maxScore: 'max' in band.value ? band.value.max : undefined,
  source: src.value || undefined,
}))
const filtered = computed(() => !!(filters.value.q || filters.value.step || filters.value.minScore !== undefined || filters.value.maxScore !== undefined || filters.value.source))

// ---------- one page at a time from the server ----------
const PAGE = 50
const rows = ref<ListRow[] | null>(null)
const total = ref(0)
const err = ref<string | null>(null)
const loadingMore = ref(false)
// sources aren't a fixed list: offer the ones met so far (plus Unknown), and keep a picked one even if this page lacks it
const sources = ref(new Set<string>())
let seq = 0
async function fetchRows(offset = 0) {
  const mine = ++seq
  err.value = null
  try {
    const page = await api<ListRow[]>(`/api/jobs/${props.jobId}/applications`, { query: { ...filters.value, limit: PAGE, offset } })
    if (mine !== seq) return
    rows.value = offset ? [...(rows.value ?? []), ...page] : page
    total.value = page[0]?.total ?? (offset ? total.value : 0)
    for (const r of [...page, ...props.board.preview as ListRow[]]) if (r.source) sources.value.add(r.source)
  }
  catch (e) { if (mine === seq) err.value = toApiError(e).message }
}
async function loadMore() {
  loadingMore.value = true
  await fetchRows(rows.value?.length ?? 0)
  loadingMore.value = false
}
const sourceList = computed(() => [...new Set([...sources.value, ...(src.value && src.value !== 'none' ? [src.value] : [])])].sort())

// ---------- selection: picked rows, or "all matching" minus the ones unticked ----------
const picked = ref(new Map<string, ListRow>())
const all = ref(false)
const except = ref(new Set<string>())
const isOn = (r: ListRow) => all.value ? !except.value.has(r.id) : picked.value.has(r.id)
const nSelected = computed(() => all.value ? total.value - except.value.size : picked.value.size)
function toggle(r: ListRow) {
  if (all.value) {
    if (!except.value.delete(r.id)) except.value.add(r.id)
  }
  else if (!picked.value.delete(r.id)) picked.value.set(r.id, r)
  if (all.value && nSelected.value === 0) clear()
}
const pageOn = computed(() => !!rows.value?.length && rows.value.every(isOn))
const pageSome = computed(() => !!rows.value?.some(isOn) && !pageOn.value)
function togglePage() {
  const on = !pageOn.value
  for (const r of rows.value ?? []) if (isOn(r) !== on) toggle(r)
}
function clear() {
  picked.value = new Map()
  all.value = false
  except.value = new Set()
}
const selectAll = () => (all.value = true, except.value = new Set(), picked.value = new Map())

// a new filter is a new set of people, so the selection starts over
let typing: ReturnType<typeof setTimeout> | undefined
watch(() => [show.value, whereSteps.value.join(','), band.value, src.value], () => { clear(); fetchRows() }, { immediate: true })
watch(q, () => { clearTimeout(typing); typing = setTimeout(() => { clear(); fetchRows() }, 250) })

// ---------- bulk moves: the same dialog as the board, fed with the selection grouped by where people are ----------
const dlg = ref<InstanceType<typeof BoardMoveDialog>>()
const gathering = ref<{ done: number, total: number } | null>(null)
const gatherErr = ref('')
// "All matching" with nothing but one step picked is exactly the server's "everyone at this step but…" move
const wholeStep = computed(() => all.value && show.value === 'active' && whereSteps.value.length === 1
  && !filters.value.q && !filters.value.source && filters.value.minScore === undefined && filters.value.maxScore === undefined && except.value.size <= 200)

// ponytail: pages through every match, 100 at a time, to learn where each person is; fine into the low thousands
async function everyMatch() {
  const out: ListRow[] = []
  gathering.value = { done: 0, total: total.value }
  try {
    for (let offset = 0; offset < total.value; offset += 100) {
      const page = await api<ListRow[]>(`/api/jobs/${props.jobId}/applications`, { query: { ...filters.value, limit: 100, offset } })
      out.push(...page)
      gathering.value.done = out.length
      if (page.length < 100) break
    }
    return out.filter(r => !except.value.has(r.id))
  }
  finally { gathering.value = null }
}
async function bulk(reject: boolean) {
  gatherErr.value = ''
  let parts: Part[]
  let seen = nSelected.value
  let one: ListRow | undefined
  if (wholeStep.value) parts = [{ from: { node: whereSteps.value[0]! }, except: [...except.value] }]
  else {
    let chosen: ListRow[]
    try { chosen = all.value ? await everyMatch() : [...picked.value.values()] }
    catch (e) { gatherErr.value = toApiError(e).message; return }
    const by = new Map<string, Part & { ids: string[] }>()
    for (const r of chosen) {
      const at = posOfRow(r)
      if (!at) continue
      if (!by.has(posId(at))) by.set(posId(at), { from: at, ids: [] })
      by.get(posId(at))!.ids.push(r.id)
    }
    parts = [...by.values()]
    seen = chosen.length
    one = chosen.length === 1 ? chosen[0] : undefined
  }
  const froms = new Set(parts.map(p => posId(p.from)))
  const drop: Drop = {
    parts,
    seen,
    name: one && fullName(one.candidate),
    fromLabel: froms.size === 1 ? label(parts[0]!.from) : `${froms.size} places`,
    to: reject ? targets.value.find(t => t.id === 'c:rejected')! : null,
  }
  dlg.value!.open(drop)
}
function onMoved() {
  clear()
  fetchRows()
  emit('reload')
}

// "Tomás H., Mei T. +1": who still owes a scorecard (people who already sent theirs are left out)
const owing = (r: ListRow) => {
  const open = r.assignees.filter(a => !a.submitted)
  return open.length ? open : r.assignees
}
const holders = (r: ListRow) => {
  const short = (n: string) => n.split(/\s+/).length > 1 ? `${n.split(/\s+/)[0]} ${n.split(/\s+/).at(-1)![0]}.` : n
  const list = owing(r).map(a => short(a.name))
  return list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2}` : list.join(', ')
}
const late = (r: ListRow) => !!r.dueAt && new Date(r.dueAt).getTime() < Date.now()
const resetFilters = () => setQuery({ q: undefined, stage: undefined, step: undefined, score: undefined, src: undefined })
</script>

<template>
  <div class="list">
    <div class="filters" :inert="nSelected > 0">
      <label class="search">
        <Icon name="search" :size="16" />
        <span class="sr-only">Search by name or email</span>
        <input type="search" :value="q" placeholder="Search name or email" @input="setQuery({ q: ($event.target as HTMLInputElement).value || undefined })">
      </label>
      <select aria-label="Stage or step" :value="where" @change="setWhere(($event.target as HTMLSelectElement).value)">
        <option value="">Every stage</option>
        <optgroup v-for="c in columns.filter(c => c.id !== 'closed')" :key="c.id" :label="c.name">
          <option v-if="c.rows.length > 1" :value="`s:${c.id}`">All of {{ c.name }}</option>
          <option v-for="r in c.rows" :key="r.id" :value="r.id">{{ r.label }}</option>
        </optgroup>
      </select>
      <select aria-label="AI score" :value="band.value" @change="setQuery({ score: ($event.target as HTMLSelectElement).value || undefined })">
        <option v-for="b in SCORE_BANDS" :key="b.value" :value="b.value">{{ b.label }}</option>
      </select>
      <select aria-label="Source" :value="src" @change="setQuery({ src: ($event.target as HTMLSelectElement).value || undefined })">
        <option value="">Any source</option>
        <option v-for="s in sourceList" :key="s" :value="s">{{ sourceLabel(s) }}</option>
        <option value="none">Unknown source</option>
      </select>
      <select aria-label="Status" :value="show" @change="setQuery({ show: ($event.target as HTMLSelectElement).value === 'active' ? undefined : ($event.target as HTMLSelectElement).value })">
        <option v-for="s in STATUS" :key="s.value" :value="s.value">{{ s.label }} ({{ countOf(s.value).toLocaleString() }})</option>
      </select>
    </div>

    <div v-if="isManager && nSelected" class="selbar" role="region" aria-label="Selected candidates">
      <b>{{ nSelected.toLocaleString() }} selected</b>
      <span class="of">of {{ total.toLocaleString() }} matching</span>
      <button v-if="!all && total > nSelected" type="button" class="linkish" @click="selectAll">Select all {{ total.toLocaleString() }}</button>
      <button type="button" class="linkish" @click="clear">Clear</button>
      <span class="grow" />
      <span v-if="gathering" class="gather" role="status"><span class="spinner" />Finding {{ gathering.done.toLocaleString() }} of {{ gathering.total.toLocaleString() }}…</span>
      <span v-else-if="gatherErr" class="gather" role="alert"><Icon name="alert" :size="14" />{{ gatherErr }}</span>
      <button type="button" class="btn btn-sm" :disabled="!!gathering" @click="bulk(false)"><Icon name="move" />Move…</button>
      <button type="button" class="btn btn-sm reject" :disabled="!!gathering" @click="bulk(true)">Reject…</button>
    </div>

    <div v-if="err" class="form-error" role="alert">
      <Icon name="alert" />{{ err }} <button class="btn btn-sm" @click="fetchRows()">Retry</button>
    </div>
    <div v-else-if="!rows" class="panel" aria-busy="true">
      <div v-for="i in 8" :key="i" class="sk-row"><span class="skeleton" style="width: 22%" /><span class="skeleton" style="width: 18%" /><span class="skeleton" style="width: 8%" /><span class="skeleton" style="width: 12%" /></div>
    </div>
    <div v-else class="panel" :class="{ selecting: nSelected }">
      <table class="table">
        <thead>
          <tr>
            <th v-if="isManager" class="tick"><input type="checkbox" :checked="pageOn" :indeterminate="pageSome" :disabled="!rows.length" aria-label="Select everyone on this page" @change="togglePage"></th>
            <th>Candidate</th><th>Stage · step</th><th class="num">AI score</th><th>Source</th><th>Applied</th><th>In step</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ on: isOn(r) }">
            <td v-if="isManager" class="tick"><input type="checkbox" :checked="isOn(r)" :aria-label="`Select ${fullName(r.candidate)}`" @change="toggle(r)"></td>
            <td>
              <div class="who">
                <Avatar :name="fullName(r.candidate)" :size="28" />
                <div>
                  <NuxtLink :to="`/candidates/${r.id}`" class="row-link">{{ fullName(r.candidate) }}</NuxtLink>
                  <span class="faint email">{{ r.candidate.email }}</span>
                </div>
              </div>
            </td>
            <td><div class="where">
              <span v-if="r.status === 'closed'" class="chip" :class="OUTCOME[r.outcome ?? '']?.chip">{{ OUTCOME[r.outcome ?? '']?.text ?? 'Closed' }}</span>
              <template v-else>
                <span class="place">{{ stageOf(r.currentNodeKey) ? `${stageOf(r.currentNodeKey)!.name} · ` : '' }}{{ label(posOfRow(r)) }}</span>
                <span class="state">
                  <template v-if="r.runStatus === 'waiting_on_human' && r.assignees.length">
                    <span class="names">{{ holders(r) }}</span>
                    <DueChip v-if="r.dueAt" :due="r.dueAt" />
                  </template>
                  <span v-else-if="r.runStatus === 'failed'" class="chip chip-bad"><Icon name="stop" />Failed</span>
                  <span v-else-if="late(r)" class="chip chip-warn"><Icon name="clock" />Late</span>
                </span>
              </template>
            </div></td>
            <td class="num"><span v-if="r.score !== null" class="chip">{{ Math.round(r.score) }}</span><span v-else class="faint">–</span></td>
            <td class="src">{{ r.source ? sourceLabel(r.source) : '' }}<span v-if="!r.source" class="faint">–</span></td>
            <td class="nowrap">{{ fmtDate(r.createdAt) }}</td>
            <td class="nowrap">{{ r.status === 'active' ? inStep(r.since) : '' }}</td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="isManager ? 7 : 6" class="none">
              <template v-if="filtered">Nobody matches these filters. <button class="btn btn-sm btn-quiet" @click="resetFilters">Clear filters</button></template>
              <template v-else>Nobody {{ show === 'all' ? 'here' : STATUS.find(s => s.value === show)!.label.toLowerCase() }} yet.</template>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="rows.length < total" class="more">
        <span class="faint">Showing {{ rows.length.toLocaleString() }} of {{ total.toLocaleString() }}</span>
        <button class="btn btn-sm" :aria-busy="loadingMore" :disabled="loadingMore" @click="loadMore"><span v-if="loadingMore" class="spinner" />Show {{ Math.min(PAGE, total - rows.length) }} more</button>
      </div>
    </div>

    <BoardMoveDialog ref="dlg" :job-id="jobId" :targets="targets" :graph="graph" :name-of="nameOf" @moved="onMoved" />
  </div>
</template>

<style scoped>
.list { display: grid; gap: 12px; min-width: 0; }
.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.filters select { width: auto; max-width: 220px; }
.search { position: relative; display: block; width: 240px; }
.search svg { position: absolute; left: 12px; top: 50%; translate: 0 -50%; color: var(--ink-3); pointer-events: none; }
.search input { padding-left: 36px; }

/* the selection bar: dark, the one place bulk actions live, stuck to the top while the list scrolls.
   It lies over the filter row (same cell, same height) so ticking the first box doesn't push the rows down. */
.filters, .selbar { grid-area: 1 / 1; }
.selbar {
  position: sticky; top: 8px; z-index: 3; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  min-height: var(--h-md); padding: 4px 4px 4px 16px; border-radius: var(--r-panel); background: var(--ink); color: #fff; font-size: var(--t-sm); box-shadow: var(--shadow-2);
  animation: bar-in var(--t-micro) var(--ease);
}
@keyframes bar-in { from { opacity: 0; translate: 0 -4px; } }
.selbar b { font-variant-numeric: tabular-nums; }
.of { opacity: 0.75; font-variant-numeric: tabular-nums; }
.grow { flex: 1; }
.linkish { padding: 0; border: 0; background: none; font: inherit; font-weight: 600; color: #fff; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.linkish:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 4px; }
.gather { display: inline-flex; align-items: center; gap: 6px; opacity: 0.85; font-variant-numeric: tabular-nums; }
.selbar .btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.selbar .reject { --b-bg: var(--bad-tint); --b-fg: var(--bad); --b-ring: transparent; }
@media (hover: hover) and (pointer: fine) { .selbar .reject:hover:not(:disabled) { --b-bg: oklch(0.93 0.05 27); } }

/* the header stays put over long lists; the panel can't clip it, so no overflow on the wrapper */
.table th { position: sticky; top: 0; z-index: 1; }
.selecting .table th { position: static; }
.table thead th:first-child { border-top-left-radius: var(--r-panel); }
.table thead th:last-child { border-top-right-radius: var(--r-panel); }
.tick { width: 44px; padding-right: 0; }
.tick input { display: grid; } /* grid, not block: the base centres the tick with place-content */
tbody tr.on { background: var(--accent-tint); }
.who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.who > div { min-width: 0; }
.who .row-link { display: block; overflow-wrap: anywhere; }
.email { display: block; font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 30ch; }
.where { display: grid; gap: 4px; justify-items: start; }
.place { overflow-wrap: anywhere; }
.state { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.state:empty { display: none; }
.names { font-size: var(--t-sm); color: var(--ink-2); }
.src { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.none { text-align: center; color: var(--ink-2); padding: 32px; }
.more { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--line); font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
.sk-row { display: flex; gap: 32px; padding: 16px; border-bottom: 1px solid var(--line); }
.sk-row:last-child { border-bottom: 0; }
.sk-row .skeleton { height: 14px; }
.form-error .btn { margin-left: auto; }
</style>
