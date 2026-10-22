<script setup lang="ts">
import type { Board, PipelineRow } from '~/pages/jobs/[id].vue'
import { type Person, type Pos, type Row, posId, resting } from '~/lib/board'
import BoardMoveDialog, { type Drop } from './BoardMoveDialog.vue'
import BoardFindDialog, { type FindScope } from './BoardFindDialog.vue'

const props = defineProps<{ jobId: string, board: Board }>()
const emit = defineEmits<{ reload: [] }>()
const { isManager } = useMe()
const toast = useToast()

// ---------- columns: stages, then steps no stage claims, then Closed ----------
const OUTCOMES = [
  { key: 'hired', label: 'Hired', slot: 'ok' },
  { key: 'rejected', label: 'Rejected', slot: 'line' },
  { key: 'withdrawn', label: 'Withdrawn', slot: 'line' },
] as const
const steps = computed(() => props.board.steps.filter(s => resting(s.type)))
const stepRow = (s: Board['steps'][number]): Row => ({ id: `n:${s.key}`, pos: { node: s.key }, label: nodeLabel(s), type: s.type })
const columns = computed(() => {
  const byKey = new Map(steps.value.map(s => [s.key, s]))
  const claimed = new Set<string>()
  const cols: { id: string, name: string, rows: Row[], hint?: string }[] = []
  for (const st of props.board.stages ?? []) {
    const rows = st.nodeKeys.flatMap(k => byKey.has(k) && !claimed.has(k) ? (claimed.add(k), [stepRow(byKey.get(k)!)]) : [])
    cols.push({ id: st.id, name: st.name, rows, hint: rows.length ? undefined : 'No steps in this stage yet. Add them on the Flow tab.' })
  }
  const rest = steps.value.filter(s => !claimed.has(s.key))
  // no stages at all: one column per step, the plain kanban
  if (!props.board.stages?.length) for (const s of rest) cols.push({ id: s.key, name: nodeLabel(s), rows: [stepRow(s)] })
  else if (rest.length) cols.push({ id: 'other', name: 'Other steps', rows: rest.map(stepRow) })
  cols.push({ id: 'closed', name: 'Closed', rows: OUTCOMES.map(o => ({ id: `c:${o.key}`, pos: { closed: o.key }, label: o.label })) })
  return cols
})
const rowLabel = (pos: Pos) => columns.value.flatMap(c => c.rows).find(r => r.id === posId(pos))?.label

const countAt = (pos: Pos) => props.board.counts.find(c => 'node' in pos
  ? c.status === 'active' && c.key === pos.node
  : c.status === 'closed' && c.outcome === pos.closed) ?? { n: 0, failed: 0, overdue: 0 }
const colTotal = (rows: Row[]) => rows.reduce((n, r) => n + countAt(r.pos).n, 0)

// ---------- people pulled out of their group; gone on reload, as everything groups again ----------
const picked = ref<Person[]>([])
const pickedAt = (pos: Pos) => picked.value.filter(p => posId(p.at) === posId(pos))
const groupN = (pos: Pos) => Math.max(0, countAt(pos).n - pickedAt(pos).length)
// the slot says who acts at this step, as everywhere else; "stopped" is said by its chip, in words
const slotOf = (r: Row) => 'closed' in r.pos ? (r.pos.closed === 'hired' ? 'ok' : 'line') : nodeMeta(r.type!).slot

// ---------- find: one list for "Find a candidate" and each card's "See who"; picking pulls them out ----------
const finder = ref<InstanceType<typeof BoardFindDialog>>()
// the select's choices: everyone, then each stage whole and step by step, then the outcomes
const scopes = computed<FindScope[]>(() => {
  const sum = (f: (c: Board['counts'][number]) => boolean) => props.board.counts.filter(f).reduce((n, c) => n + c.n, 0)
  const out: FindScope[] = [
    { id: 'all', label: 'Everyone', n: sum(() => true), show: 'all' },
    { id: 'active', label: 'Everyone in progress', n: sum(c => c.status === 'active'), show: 'active' },
  ]
  for (const c of columns.value) {
    if (c.id === 'closed') {
      for (const r of c.rows) out.push({ id: r.id, label: r.label, group: c.name, n: countAt(r.pos).n, show: (r.pos as { closed: FindScope['show'] }).closed })
      continue
    }
    if (c.rows.length > 1) out.push({ id: `s:${c.id}`, label: `All of ${c.name}`, group: c.name, n: colTotal(c.rows), show: 'active', steps: c.rows.map(r => (r.pos as { node: string }).node) })
    for (const r of c.rows) out.push({ id: r.id, label: r.label, group: c.name, n: countAt(r.pos).n, show: 'active', steps: [(r.pos as { node: string }).node] })
  }
  return out
})
// the first faces of a group, from the board's preview; people pulled out are on their own cards
const facesAt = (pos: Pos) => props.board.preview.filter(r => posId(posOfRow(r) ?? { node: '' }) === posId(pos) && !picked.value.some(p => p.id === r.id))
const posOfRow = (r: PipelineRow): Pos | null => r.status === 'closed' ? { closed: r.outcome as 'hired' } : r.currentNodeKey ? { node: r.currentNodeKey } : null

async function pick(r: PipelineRow) {
  const at = posOfRow(r)
  const name = fullName(r.candidate)
  if (!at || !rowLabel(at)) return toast.show(`${name} is at a step the board doesn’t show. Open them to move them.`)
  if (!picked.value.some(p => p.id === r.id)) picked.value.push({ id: r.id, name, email: r.candidate.email, at })
  await nextTick()
  const el = document.querySelector<HTMLElement>(`[data-person="${r.id}"]`)
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  el?.focus({ preventScroll: true })
}
const unpick = (id: string) => (picked.value = picked.value.filter(p => p.id !== id))

// ---------- drag ----------
type Dragging = { kind: 'group', from: Pos } | { kind: 'person', person: Person }
const dragging = ref<Dragging | null>(null)
const over = ref<string | null>(null)
const fromOf = (d: Dragging) => d.kind === 'group' ? d.from : d.person.at
// any other row; closing a closed application needs a reopen first, so Closed → Closed is not a move
const canDrop = (r: Row) => {
  const d = dragging.value
  if (!d) return false
  const from = fromOf(d)
  return posId(from) !== r.id && !('closed' in from && 'closed' in r.pos)
}
function onDragStart(e: DragEvent, d: Dragging) {
  dragging.value = d
  e.dataTransfer!.setData('application/x-card', posId(fromOf(d)))
  e.dataTransfer!.effectAllowed = 'move'
}
function onDragOver(e: DragEvent, r: Row) {
  if (!canDrop(r)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
  over.value = r.id
}
function onDrop(r: Row) {
  const d = dragging.value
  const ok = canDrop(r)
  onDragEnd()
  if (d && ok) ask(d, r)
}
const onDragEnd = () => (dragging.value = null, over.value = null)

// ---------- moving: always through the confirm, which says what will happen ----------
const dlg = ref<InstanceType<typeof BoardMoveDialog>>()
function ask(d: Dragging, to?: Row) {
  const drop: Drop = d.kind === 'group'
    ? { from: d.from, fromLabel: rowLabel(d.from)!, people: null, except: pickedAt(d.from).map(p => p.id), seen: groupN(d.from), to: to ?? null }
    : { from: d.person.at, fromLabel: rowLabel(d.person.at)!, people: [d.person], except: [], seen: 1, to: to ?? null }
  dlg.value!.open(drop)
}
// keyboard path: every row is a target in the dialog's picker
const targets = computed(() => columns.value.flatMap(c => c.rows.map(r => ({ ...r, group: c.name }))))

// Moving in the background: the source group drains as the queue works. Watch it, then stop.
const moving = ref<{ from: Pos, to: Pos, total: number, until: number, deadline: number } | null>(null)
let poll: ReturnType<typeof setInterval> | undefined
function onMoved(res: { kind: 'sync', moved: { id: string, currentNodeKey: string | null, status: 'active' | 'closed', outcome: string | null }[] } | { kind: 'queued', from: Pos, to: Pos, queued: number }) {
  if (res.kind === 'sync') {
    for (const m of res.moved) {
      const p = picked.value.find(x => x.id === m.id)
      const at = m.status === 'closed' ? { closed: m.outcome as 'hired' } : m.currentNodeKey ? { node: m.currentNodeKey } : null
      if (p && at) p.at = at
    }
    emit('reload')
    return
  }
  if (!res.queued) return
  moving.value = { from: res.from, to: res.to, total: res.queued, until: Math.max(0, countAt(res.from).n - res.queued), deadline: Date.now() + 120_000 }
  clearInterval(poll)
  // ponytail: polls the counts until the source drains; add a moves table if exact progress matters
  poll = setInterval(() => emit('reload'), 2000)
}
watch(() => props.board, () => {
  const m = moving.value
  if (m && (countAt(m.from).n <= m.until || Date.now() > m.deadline)) {
    clearInterval(poll)
    moving.value = null
  }
})
onBeforeUnmount(() => clearInterval(poll))
const movingLeft = computed(() => moving.value ? Math.max(0, countAt(moving.value.from).n - moving.value.until) : 0)
</script>

<template>
  <div class="board-wrap">
    <div class="tools">
      <button type="button" class="btn find-btn" @click="finder!.open()"><Icon name="search" :size="16" />Find a candidate</button>
      <p v-if="moving" class="moving" role="status">
        <span class="spinner" />Moving {{ movingLeft.toLocaleString() }} of {{ moving.total.toLocaleString() }} to {{ rowLabel(moving.to) }}
      </p>
    </div>

    <div class="board" role="list" aria-label="Pipeline by stage">
      <section v-for="c in columns" :key="c.id" class="col" :class="{ closed: c.id === 'closed' }" role="listitem" :aria-labelledby="`col-${c.id}`">
        <header class="col-head">
          <h3 :id="`col-${c.id}`">{{ c.name }}</h3>
          <span class="col-n">{{ colTotal(c.rows).toLocaleString() }}</span>
        </header>
        <p v-if="c.hint" class="col-hint">{{ c.hint }}</p>
        <!-- equal shares while the cards fit; a row with more cards grows and the column scrolls -->
        <div v-else class="rows" :style="{ gridTemplateRows: `repeat(${c.rows.length}, minmax(min-content, 1fr))` }">
          <div
            v-for="r in c.rows" :key="r.id" class="row" :class="{ over: over === r.id, target: dragging && canDrop(r) }"
            @dragover="onDragOver($event, r)" @dragleave="over === r.id && (over = null)" @drop.prevent="onDrop(r)"
          >
            <div v-if="c.rows.length > 1 || c.id === 'closed'" class="row-head">
              <Icon v-if="r.type" :name="nodeMeta(r.type).icon" :size="14" />{{ r.label }}
            </div>

            <!-- people pulled out by search, or just moved: first, so they're never scrolled out of sight -->
            <article
              v-for="p in pickedAt(r.pos)" :key="p.id" class="card person" :data-person="p.id" data-slot="accent" tabindex="-1"
              :draggable="isManager" @dragstart="onDragStart($event, { kind: 'person', person: p })" @dragend="onDragEnd"
            >
              <div class="p-top">
                <NuxtLink :to="`/candidates/${p.id}`" class="p-name">{{ p.name }}</NuxtLink>
                <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Put ${p.name} back in the group`" title="Put back in the group" @click="unpick(p.id)"><Icon name="x" :size="14" /></button>
              </div>
              <span class="p-email">{{ p.email }}</span>
              <button v-if="isManager" type="button" class="btn btn-quiet btn-sm p-move" @click="ask({ kind: 'person', person: p })"><Icon name="move" />Move…</button>
            </article>

            <!-- the group: everyone here, as one stack of badges -->
            <article
              v-if="groupN(r.pos)" class="card group" :data-slot="slotOf(r)" :data-stack="groupN(r.pos) >= 10 ? 2 : groupN(r.pos) > 1 ? 1 : 0"
              :draggable="isManager" :aria-label="`${groupN(r.pos)} at ${r.label}`"
              @dragstart="onDragStart($event, { kind: 'group', from: r.pos })" @dragend="onDragEnd"
            >
              <!-- the move sits by the count it moves; the faces and "See more" are one way in to the list -->
              <div class="g-top">
                <div class="g-n"><b>{{ groupN(r.pos).toLocaleString() }}</b> {{ groupN(r.pos) === 1 ? 'person' : 'people' }}</div>
                <button v-if="isManager" type="button" class="btn btn-quiet btn-sm g-move" :aria-label="`Move all ${groupN(r.pos).toLocaleString()} at ${r.label}…`" title="Move all…" @click="ask({ kind: 'group', from: r.pos })">
                  <Icon name="move" />Move…
                </button>
              </div>
              <div v-if="countAt(r.pos).failed || countAt(r.pos).overdue" class="g-flags">
                <span v-if="countAt(r.pos).failed" class="chip chip-bad"><Icon name="stop" />{{ countAt(r.pos).failed }} stopped</span>
                <span v-if="countAt(r.pos).overdue" class="chip chip-warn"><Icon name="clock" />{{ countAt(r.pos).overdue }} late</span>
              </div>
              <button type="button" class="g-see" :aria-label="`See more of the ${groupN(r.pos).toLocaleString()} at ${r.label}`" @click="finder!.open(r.id)">
                <span v-if="facesAt(r.pos).length" class="faces" aria-hidden="true">
                  <Avatar v-for="f in facesAt(r.pos)" :key="f.id" :name="f.candidate.firstName" :size="24" />
                </span>
                See more
              </button>
            </article>

            <p v-if="!groupN(r.pos) && !pickedAt(r.pos).length" class="nobody">{{ dragging && canDrop(r) ? 'Drop here' : 'Nobody here' }}</p>
          </div>
        </div>
      </section>
    </div>

    <BoardFindDialog ref="finder" :job-id="jobId" :label-of="rowLabel" :scopes="scopes" :preview="board.preview" @pick="pick" />
    <BoardMoveDialog ref="dlg" :job-id="jobId" :targets="targets" :steps="board.steps" @moved="onMoved" />
  </div>
</template>

<style scoped>
.board-wrap { display: grid; gap: 14px; min-width: 0; }
.tools { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.find-btn { min-width: 240px; justify-content: flex-start; color: var(--ink-2); }
.find-btn svg { color: var(--ink-3); }
.moving { display: inline-flex; align-items: center; gap: 8px; font-size: var(--t-sm); font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; }

/* columns scroll sideways inside the board; the page itself never does */
.board {
  display: grid; grid-auto-flow: column; grid-auto-columns: 272px; gap: 12px; align-items: stretch;
  overflow-x: auto; padding-bottom: 8px; height: max(520px, calc(100dvh - 300px));
}
.col { display: flex; flex-direction: column; min-height: 0; border-radius: var(--r-panel); background: var(--sunk); }
.col.closed { background: none; box-shadow: inset 0 0 0 1px var(--line); }
.col-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 14px 14px 10px; }
.col-head h3 { font-size: var(--t-md); overflow-wrap: anywhere; }
.col-n { font-size: var(--t-sm); font-weight: 600; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.col-hint { padding: 0 14px 14px; font-size: var(--t-sm); color: var(--ink-2); }
.rows { flex: 1; min-height: 0; overflow-y: auto; display: grid; padding: 0 8px 8px; gap: 8px; }
.row {
  display: flex; flex-direction: column; gap: 8px; min-height: 156px; padding: 8px; border-radius: 12px;
  outline: 1.5px dashed transparent; outline-offset: -1.5px; transition: background var(--t-micro) var(--ease), outline-color var(--t-micro) var(--ease);
}
.row + .row { border-top: 1px solid var(--line-2); border-top-left-radius: 0; border-top-right-radius: 0; }
.row.target { outline-color: var(--line-2); }
.row.over { background: var(--accent-tint); outline-color: var(--accent); }
.row-head { display: flex; align-items: center; gap: 6px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); padding: 0 2px; }
.row-head svg { flex: none; color: var(--ink-3); }
.nobody { margin: auto 0; text-align: center; font-size: var(--t-sm); color: var(--ink-3); }
.row.over .nobody { color: var(--accent-ink); font-weight: 600; }

.card { padding: 22px 14px 10px; border-radius: 16px; }
.card[draggable="true"] { cursor: grab; }
.card[draggable="true"]:active { cursor: grabbing; }
/* closed is the record, not the work: flat cards, no pile */
.closed .card { box-shadow: none; background: transparent; }
.col.closed .group.card { margin-bottom: 0; box-shadow: none; }
/* a pile of badges: one edge behind for a few people, two for ten or more */
.group[data-stack="1"] { margin-bottom: 5px; box-shadow: 0 5px 0 -2px var(--surface), 0 5px 0 -1px var(--line-2), var(--shadow-2); }
.group[data-stack="2"] { margin-bottom: 10px; box-shadow: 0 5px 0 -2px var(--surface), 0 5px 0 -1px var(--line-2), 0 10px 0 -4px var(--surface), 0 10px 0 -3px var(--line-2), var(--shadow-2); }
.g-n { color: var(--ink-2); font-size: var(--t-sm); }
.g-n b { font-size: var(--t-2xl); font-weight: 600; letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 2px; }
.g-flags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.g-top { display: flex; align-items: center; justify-content: space-between; gap: 4px 8px; flex-wrap: wrap; margin-right: -6px; }
.g-move { flex: none; }
/* faces and words are one control: the pile of the first five, then what clicking it does */
.g-see {
  display: inline-flex; align-items: center; gap: 8px; margin: 10px 0 0 -6px; padding: 4px 10px 4px 6px; border: 0; border-radius: var(--r-pill);
  background: none; font: inherit; font-size: var(--t-sm); font-weight: 500; color: var(--ink-2); cursor: pointer;
}
.g-see:hover { background: var(--hover); color: var(--ink); }
.g-see:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.faces { display: inline-flex; }
.faces .avatar + .avatar { margin-left: -6px; }
.faces .avatar { box-shadow: 0 0 0 2px var(--surface); }
.g-see:hover .faces .avatar { box-shadow: 0 0 0 2px var(--hover); }
.closed .faces .avatar { box-shadow: 0 0 0 2px var(--bg); }
.person { padding-top: 20px; }
.person:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.person:focus { box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent), var(--shadow-2); }
.p-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-right: -6px; }
.p-name { font-weight: 600; color: var(--ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-name:hover { color: var(--accent-ink); }
.p-email { display: block; font-size: var(--t-sm); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-move { margin: 6px 0 0 -8px; }
</style>
