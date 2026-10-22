<script setup lang="ts">
import type { PipelineRow, PipelineState } from '../[id].vue'

const route = useRoute()
const router = useRouter()
const id = route.params.id as string
const { detail } = useJob(id)
const { board, error, load } = inject<PipelineState>('pipeline')!

const view = computed(() => route.query.view === 'list' ? 'list' : 'board')
const FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
] as const
type Filter = typeof FILTERS[number]['value']
const filter = computed<Filter>(() => FILTERS.some(f => f.value === route.query.show) ? route.query.show as Filter : 'active')
const q = computed(() => (route.query.q as string | undefined) ?? '')
const stepFilter = computed(() => (route.query.step as string | undefined) ?? '')

// counts come from the board, so they cover everyone, not just the loaded page
const counts = computed(() => board.value?.counts ?? [])
const count = (f: Filter) => counts.value.filter(c => f === 'all' || (f === 'active' ? c.status === 'active' : c.outcome === f)).reduce((n, c) => n + c.n, 0)
const total = computed(() => count('all'))

// ---------- the list: one page at a time from the server ----------
const PAGE = 50
const rows = ref<PipelineRow[] | null>(null)
const more = ref(false)
const listError = ref<string | null>(null)
const loadingMore = ref(false)
let seq = 0
async function fetchRows(offset = 0) {
  const mine = ++seq
  listError.value = null
  try {
    const page = await api<PipelineRow[]>(`/api/jobs/${id}/applications`, {
      query: { show: filter.value, q: q.value.trim() || undefined, step: stepFilter.value || undefined, limit: PAGE, offset },
    })
    if (mine !== seq) return
    rows.value = offset ? [...(rows.value ?? []), ...page] : page
    more.value = page.length === PAGE
  }
  catch (e) { if (mine === seq) listError.value = toApiError(e).message }
}
async function loadMore() {
  loadingMore.value = true
  await fetchRows(rows.value?.length ?? 0)
  loadingMore.value = false
}
let typing: ReturnType<typeof setTimeout> | undefined
watch([view, filter, stepFilter], () => { if (view.value === 'list') fetchRows() }, { immediate: true })
watch(q, () => { clearTimeout(typing); typing = setTimeout(() => view.value === 'list' && fetchRows(), 250) })

// "Tomás H., Mei T. +1": who still owes a scorecard (people who already sent theirs are left out)
const owing = (r: PipelineRow) => {
  const open = r.assignees.filter(a => !a.submitted)
  return open.length ? open : r.assignees
}
const holders = (r: PipelineRow) => {
  const short = (n: string) => n.split(/\s+/).length > 1 ? `${n.split(/\s+/)[0]} ${n.split(/\s+/).at(-1)![0]}.` : n
  const list = owing(r).map(a => short(a.name))
  return list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2}` : list.join(', ')
}

// Where the active candidates are now, so a step that piles up shows before scrolling. Filters by ?step=.
const byStep = computed(() => counts.value.filter(c => c.status === 'active' && c.key)
  .map(c => ({ key: c.key!, n: c.n, label: step(c.key)?.label ?? c.key!, stopped: c.failed > 0 }))
  .sort((a, b) => b.n - a.n))
// the flow version only matters when candidates are on different ones
const mixedVersions = computed(() => new Set((rows.value ?? []).map(r => r.version)).size > 1)

const setQuery = (patch: Record<string, string | undefined>) => router.replace({ query: { ...route.query, ...patch } })

// Step names come from the flow; rows on older versions may name a step that's gone, so fall back to the key.
const nodes = computed(() => [...(board.value?.steps ?? []), ...(detail.value?.published?.workflow.nodes ?? []), ...(detail.value?.draft?.workflow.nodes ?? [])])
const step = (key: string | null) => {
  const n = nodes.value.find(n => n.key === key)
  // an End step repeats the outcome chip, so it isn't shown as a step
  if (!key || n?.type === 'end') return null
  return { label: n ? nodeLabel(n) : key, key, icon: n ? nodeMeta(n.type).icon : 'more', named: !!n?.label }
}
const live = computed(() => detail.value?.job.status === 'open')
const everPublished = computed(() => !!detail.value?.published)
</script>

<template>
  <div>
    <div v-if="error" class="form-error" role="alert">
      <Icon name="alert" />{{ error }} <button class="btn btn-sm" @click="load">Retry</button>
    </div>

    <div v-else-if="!board || !detail" class="panel" aria-busy="true">
      <div v-for="i in 8" :key="i" class="sk-row"><span class="skeleton" style="width: 22%" /><span class="skeleton" style="width: 18%" /><span class="skeleton" style="width: 16%" /><span class="skeleton" style="width: 10%" /></div>
    </div>

    <section v-else-if="!total" class="panel empty">
      <template v-if="!everPublished">
        <h2>No applications yet</h2>
        <p>Publish the job to start taking applications.</p>
      </template>
      <template v-else-if="live">
        <h2>No applications yet</h2>
        <p>Share the apply link wherever you post the job.</p>
        <JobCopyLink :job-id="id" class="empty-link" />
      </template>
      <template v-else>
        <h2>No applications</h2>
        <p>Nobody applied while the job was open.</p>
      </template>
    </section>

    <template v-else>
      <div class="views">
        <div class="seg" role="radiogroup" aria-label="View">
          <label><input type="radio" name="view" value="board" :checked="view === 'board'" @change="setQuery({ view: undefined })"><span>Board</span></label>
          <label><input type="radio" name="view" value="list" :checked="view === 'list'" @change="setQuery({ view: 'list' })"><span>List</span></label>
        </div>
      </div>

      <PipelineBoard v-if="view === 'board'" :job-id="id" :board="board" @reload="load" />

      <template v-else>
      <div class="tools">
        <div class="seg" role="radiogroup" aria-label="Show applications">
          <label v-for="f in FILTERS" :key="f.value">
            <input type="radio" name="show" :value="f.value" :checked="filter === f.value" @change="setQuery({ show: f.value === 'active' ? undefined : f.value })">
            <span>{{ f.label }} <b class="n">{{ count(f.value).toLocaleString() }}</b></span>
          </label>
        </div>
        <label class="search">
          <Icon name="search" :size="16" />
          <span class="sr-only">Search candidates by name</span>
          <input type="search" :value="q" placeholder="Search by name" @input="setQuery({ q: ($event.target as HTMLInputElement).value || undefined })">
        </label>
      </div>

      <nav v-if="filter === 'active' && byStep.length > 1" class="steps" aria-label="Active candidates by step">
        <button v-for="s in byStep" :key="s.key" class="step-n" :class="{ stopped: s.stopped }" :aria-pressed="stepFilter === s.key" @click="setQuery({ step: stepFilter === s.key ? undefined : s.key })">
          <Icon v-if="s.stopped" name="stop" :size="14" /><b>{{ s.n.toLocaleString() }}</b> {{ s.label }}<span v-if="s.stopped" class="sr-only">, some stopped</span>
        </button>
      </nav>

      <div v-if="listError" class="form-error" role="alert">
        <Icon name="alert" />{{ listError }} <button class="btn btn-sm" @click="fetchRows()">Retry</button>
      </div>
      <div v-else-if="!rows" class="panel" aria-busy="true">
        <div v-for="i in 8" :key="i" class="sk-row"><span class="skeleton" style="width: 22%" /><span class="skeleton" style="width: 18%" /><span class="skeleton" style="width: 16%" /><span class="skeleton" style="width: 10%" /></div>
      </div>
      <div v-else class="panel">
        <table class="table">
          <thead>
            <tr><th>Candidate</th><th>Current step</th><th>Status</th><th>Applied</th><th v-if="mixedVersions">Flow</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td class="who">
                <NuxtLink :to="`/candidates/${r.id}`" class="row-link">{{ fullName(r.candidate) }}</NuxtLink>
                <span class="faint email">{{ r.candidate.email }}</span>
              </td>
              <td>
                <span v-if="step(r.currentNodeKey)" class="step">
                  <Icon :name="step(r.currentNodeKey)!.icon" :size="14" />{{ step(r.currentNodeKey)!.label }}
                  <code v-if="!step(r.currentNodeKey)!.named" class="faint">{{ r.currentNodeKey }}</code>
                </span>
                <span v-else class="faint">–</span>
              </td>
              <td>
                <span v-if="r.status === 'closed'" class="chip" :class="OUTCOME[r.outcome ?? '']?.chip">{{ OUTCOME[r.outcome ?? '']?.text ?? 'Closed' }}</span>
                <!-- waiting on people: who holds it and by when says more than "With a person" -->
                <span v-else-if="r.runStatus === 'waiting_on_human' && r.assignees.length" class="holders">
                  <span class="faces" aria-hidden="true"><Avatar v-for="a in owing(r).slice(0, 3)" :key="a.id" :name="a.name" :size="22" /></span>
                  <span class="names">{{ holders(r) }}</span>
                  <DueChip v-if="r.dueAt" :due="r.dueAt" />
                </span>
                <RunStatus v-else-if="r.runStatus" :status="r.runStatus" />
              </td>
              <td class="nowrap">{{ fmtAgo(r.createdAt) }}</td>
              <td v-if="mixedVersions" class="mono">v{{ r.version }}</td>
            </tr>
            <tr v-if="!rows.length">
              <td :colspan="mixedVersions ? 5 : 4" class="none">
                <template v-if="q">Nobody called “{{ q }}” here. <button class="btn btn-sm btn-quiet" @click="setQuery({ q: undefined })">Clear search</button></template>
                <template v-else>No {{ FILTERS.find(f => f.value === filter)!.label.toLowerCase() }} applications.</template>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="more" class="more">
          <button class="btn btn-sm" :aria-busy="loadingMore" :disabled="loadingMore" @click="loadMore"><span v-if="loadingMore" class="spinner" />Show {{ PAGE }} more</button>
        </div>
      </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.views { margin-bottom: 16px; }
.more { display: flex; justify-content: center; padding: 12px; border-top: 1px solid var(--line); }
.tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.n { font-weight: 600; color: var(--ink-3); }
.search { position: relative; display: block; width: 260px; }
.search svg { position: absolute; left: 12px; top: 50%; translate: 0 -50%; color: var(--ink-3); pointer-events: none; }
.search input { padding-left: 36px; }
/* the header stays put over long lists; the panel can't clip it, so no overflow on the wrapper */
.table th { position: sticky; top: 0; z-index: 1; }
.table thead th:first-child { border-top-left-radius: var(--r-panel); }
.table thead th:last-child { border-top-right-radius: var(--r-panel); }
.who { min-width: 0; }
.who .row-link { display: block; overflow-wrap: anywhere; }
.email { display: block; font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 32ch; }
.step { display: inline-flex; align-items: center; gap: 6px; }
.step svg { color: var(--ink-3); flex: none; }
.step code { font-size: var(--t-xs); }
.nowrap { white-space: nowrap; }
.holders { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.faces { display: inline-flex; }
.faces .avatar + .avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--surface); }
.names { font-size: var(--t-sm); color: var(--ink); }
.steps { display: flex; flex-wrap: wrap; gap: 6px; margin: -4px 0 14px; }
.step-n {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 0; border-radius: var(--r-pill);
  background: transparent; box-shadow: inset 0 0 0 1px var(--line-2); color: var(--ink-2); font-size: var(--t-sm); font-weight: 500; cursor: pointer;
}
.step-n b { color: var(--ink); font-variant-numeric: tabular-nums; }
.step-n.stopped b, .step-n.stopped svg { color: var(--bad); }
.step-n:hover { background: var(--hover); }
.step-n[aria-pressed="true"] { background: var(--ink); color: #fff; box-shadow: none; }
.step-n[aria-pressed="true"] b { color: #fff; }
.none { text-align: center; color: var(--ink-2); padding: 32px; }
.empty-link { width: min(520px, 100%); margin-top: 6px; }
.sk-row { display: flex; gap: 32px; padding: 16px; border-bottom: 1px solid var(--line); }
.sk-row:last-child { border-bottom: 0; }
.sk-row .skeleton { height: 14px; }
.form-error .btn { margin-left: auto; }
</style>
