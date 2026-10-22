<script lang="ts">
// A slice of the job's applications the list can be narrowed to: everyone, a stage, a step, an outcome.
export interface FindScope { id: string, label: string, group?: string, n: number, show: 'all' | 'active' | 'hired' | 'rejected' | 'withdrawn', steps?: string[] }
</script>

<script setup lang="ts">
import type { PipelineRow } from '~/pages/jobs/[id].vue'
import type { Pos } from '~/lib/board'

// One list for both ways in: "Find a candidate" (any scope, picked here) and a card's "See who" (that one group).
// It opens on the board's preview rows at once, then the server's page takes their place.
// Picking someone pulls them out of their group onto the board, ready to drag.
const props = defineProps<{ jobId: string, labelOf: (pos: Pos) => string | undefined, scopes: FindScope[], preview: PipelineRow[] }>()
const emit = defineEmits<{ pick: [row: PipelineRow] }>()
const PAGE = 30

const dlg = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const scopeId = ref('all')
const locked = ref(false) // opened from a card: the list is that group, no other
const q = ref('')
const rows = ref<PipelineRow[]>([])
const fresh = ref(false) // rows came from the server for the current query, not the preview
const total = ref(0)
const more = ref(false)
const loading = ref(false)
const active = ref(0)
const err = ref('')

const scope = computed(() => props.scopes.find(s => s.id === scopeId.value) ?? props.scopes[0]!)
const groups = computed(() => [...new Set(props.scopes.map(s => s.group))])
const inScope = (r: PipelineRow, s: FindScope) =>
  (s.show === 'all' || (s.show === 'active' ? r.status === 'active' : r.outcome === s.show))
  && (!s.steps || (r.status === 'active' && s.steps.includes(r.currentNodeKey ?? '')))

function open(id = 'all') {
  locked.value = id !== 'all'
  scopeId.value = id
  q.value = ''
  reset()
  dlg.value!.showModal()
  nextTick(() => input.value?.focus())
}
defineExpose({ open })

// the preview is in list order, so its first rows for any scope are the list's first rows
function reset() {
  rows.value = q.value.trim() ? [] : props.preview.filter(r => inScope(r, scope.value))
  total.value = scope.value.n
  fresh.value = false
  more.value = false
  active.value = 0
  load()
}

let seq = 0
async function load(offset = 0) {
  const mine = ++seq
  loading.value = true
  err.value = ''
  const s = scope.value
  try {
    const page = await api<PipelineRow[]>(`/api/jobs/${props.jobId}/applications`, {
      query: { q: q.value.trim() || undefined, show: s.show, step: s.steps?.join(','), limit: PAGE, offset },
    })
    if (mine !== seq) return
    rows.value = offset ? [...rows.value, ...page] : page
    if (page.length) total.value = page[0]!.total
    else if (!offset) total.value = 0
    fresh.value = true
    more.value = rows.value.length < total.value
    if (!offset) active.value = 0
  }
  catch (e) { if (mine === seq) err.value = toApiError(e).message }
  finally { if (mine === seq) loading.value = false }
}
let timer: ReturnType<typeof setTimeout> | undefined
watch(q, () => {
  clearTimeout(timer)
  fresh.value = false
  timer = setTimeout(load, 220)
})

const posOf = (r: PipelineRow): Pos | null => r.status === 'closed'
  ? { closed: r.outcome as 'hired' }
  : r.currentNodeKey ? { node: r.currentNodeKey } : null
const where = (r: PipelineRow) => (posOf(r) && props.labelOf(posOf(r)!)) ?? '–'
const late = (r: PipelineRow) => !!r.dueAt && new Date(r.dueAt).getTime() < Date.now()
// the scope spans more than one step or outcome, so each row says where it is
const mixed = computed(() => scope.value.show === 'all' || (scope.value.show === 'active' && (scope.value.steps?.length ?? 2) > 1))
// the count is only stated once it is true for what's typed
const counted = computed(() => fresh.value || !q.value.trim())

function pick(r: PipelineRow) {
  dlg.value!.close()
  emit('pick', r)
}
function onKey(e: KeyboardEvent) {
  const n = rows.value.length
  if (!n) return
  if (e.key === 'ArrowDown') e.preventDefault(), active.value = (active.value + 1) % n
  else if (e.key === 'ArrowUp') e.preventDefault(), active.value = (active.value + n - 1) % n
  else if (e.key === 'Enter') e.preventDefault(), pick(rows.value[active.value]!)
  else return
  nextTick(() => document.getElementById(`find-${rows.value[active.value]?.id}`)?.scrollIntoView({ block: 'nearest' }))
}
</script>

<template>
  <dialog ref="dlg" class="dialog find" aria-labelledby="find-h" @click="e => e.target === dlg && dlg!.close()">
    <div class="find-head">
      <div class="h-row">
        <h2 id="find-h">{{ locked ? scope.label : 'Find a candidate' }}</h2>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close" @click="dlg!.close()"><Icon name="x" :size="16" /></button>
      </div>
      <div class="controls">
        <label class="search">
          <Icon name="search" :size="16" />
          <span class="sr-only">Name or email</span>
          <input
            ref="input" v-model="q" type="search" :placeholder="locked ? `Search ${scope.label}` : 'Name or email'" autocomplete="off"
            role="combobox" aria-controls="find-list" aria-expanded="true" aria-autocomplete="list"
            :aria-activedescendant="rows.length ? `find-${rows[active]?.id}` : undefined" @keydown="onKey"
          >
          <span v-if="loading" class="spinner" />
        </label>
        <select v-if="!locked" v-model="scopeId" class="scope" aria-label="Where" @change="reset">
          <template v-for="g in groups" :key="g ?? ''">
            <optgroup v-if="g" :label="g">
              <option v-for="s in scopes.filter(x => x.group === g)" :key="s.id" :value="s.id">{{ s.label }} ({{ s.n.toLocaleString() }})</option>
            </optgroup>
            <template v-else>
              <option v-for="s in scopes.filter(x => !x.group)" :key="s.id" :value="s.id">{{ s.label }} ({{ s.n.toLocaleString() }})</option>
            </template>
          </template>
        </select>
      </div>
      <p class="sum" aria-live="polite">
        <template v-if="counted">
          <b>{{ total.toLocaleString() }}</b>
          {{ q.trim() ? (total === 1 ? 'match' : 'matches') : (total === 1 ? 'person' : 'people') }}<template v-if="!locked && scope.id !== 'all'"> at {{ scope.label.replace(/^All of /, '') }}</template>.
        </template>
        <template v-else>Searching…</template>
        Pick someone to pull them out onto the board.
      </p>
    </div>

    <ul id="find-list" class="list" role="listbox" aria-label="Candidates" :aria-busy="!fresh">
      <li
        v-for="(r, i) in rows" :id="`find-${r.id}`" :key="r.id" role="option" :aria-selected="i === active"
        @click="pick(r)" @mousemove="active = i"
      >
        <Avatar :name="fullName(r.candidate)" :size="32" class="r-face" />
        <span class="r-name">{{ fullName(r.candidate) }}</span>
        <span class="r-flags">
          <span v-if="mixed" class="r-where">{{ where(r) }}</span>
          <span v-if="r.runStatus === 'failed'" class="chip chip-bad"><Icon name="stop" />Stopped</span>
          <span v-else-if="late(r)" class="chip chip-warn"><Icon name="clock" />Late</span>
          <NuxtLink :to="`/candidates/${r.id}`" class="btn btn-quiet btn-icon btn-sm" tabindex="-1" :aria-label="`Open ${fullName(r.candidate)}`" title="Open candidate" @click.stop><Icon name="arrow-right" :size="14" /></NuxtLink>
        </span>
        <span class="r-sub">{{ r.candidate.email }}</span>
      </li>
      <li v-if="!rows.length && fresh" class="none" aria-disabled="true">
        <template v-if="err">{{ err }}</template>
        <template v-else-if="q.trim()">Nobody called “{{ q.trim() }}” {{ scope.id === 'all' ? 'applied to this job' : `at ${scope.label.replace(/^All of /, '')}` }}.</template>
        <template v-else>Nobody here.</template>
      </li>
    </ul>
    <div v-if="more" class="more">
      <button type="button" class="btn btn-sm" :disabled="loading" :aria-busy="loading" @click="load(rows.length)">
        <span v-if="loading" class="spinner" />Show {{ Math.min(PAGE, total - rows.length).toLocaleString() }} more
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.find { width: min(600px, calc(100vw - 32px)); padding: 0; }
.find[open] { display: flex; flex-direction: column; height: min(660px, calc(100dvh - 48px)); }
.find-head { display: grid; gap: 12px; padding: 20px 20px 12px; border-bottom: 1px solid var(--line); }
.h-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-right: -6px; }
.controls { display: flex; gap: 8px; }
.search { position: relative; display: block; flex: 1; min-width: 0; }
.search > svg { position: absolute; left: 12px; top: 50%; translate: 0 -50%; color: var(--ink-3); pointer-events: none; }
.search input { padding-left: 36px; }
.search .spinner { position: absolute; right: 36px; top: 50%; translate: 0 -50%; }
.scope { width: 200px; flex: none; }
.sum { font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.sum b { color: var(--ink); font-weight: 600; }
.list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 8px; list-style: none; }
.list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 12px; align-items: center; padding: 8px 10px; border-radius: 10px; cursor: pointer; }
.list li[aria-selected="true"] { background: var(--hover); }
.list .none { display: block; padding: 24px 10px; text-align: center; color: var(--ink-2); cursor: default; }
.r-face { grid-row: span 2; }
.r-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-flags { display: flex; align-items: center; gap: 6px; grid-row: span 2; grid-column: 3; grid-row-start: 1; margin-right: -6px; }
/* where they are: a column of its own on the right, so a scan down the list compares steps */
.r-where { font-size: var(--t-sm); color: var(--ink-2); white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.r-sub { grid-column: 2; font-size: var(--t-sm); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { padding: 8px 20px 16px; display: flex; justify-content: center; border-top: 1px solid var(--line); }
@media (max-width: 560px) { .controls { flex-wrap: wrap; } .scope { width: 100%; } }
</style>
