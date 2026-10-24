<script setup lang="ts">
import type { Board, PipelineRow } from '~/pages/jobs/[id].vue'
import type { Graph } from '~~/shared/workflow/types'
import { type ListRow, type Person, type Pos, type Row, boardColumns, boltLine, dropEffects, dropTag, inStep, posId, posOfRow } from '~/lib/board'
import BoardMoveDialog, { type Drop, type MoveResult } from './BoardMoveDialog.vue'
import BoardFindDialog, { type FindScope } from './BoardFindDialog.vue'

const props = defineProps<{ jobId: string, board: Board, graph: Graph | null, nameOf: (id: string) => string | undefined }>()
const emit = defineEmits<{ reload: [] }>()
const { isManager, canAsk } = useMe()
// Ask about a stage: the column is the subject; the outline stays while its answer is open
const asker = useAsk()
// a flow without stages has a column per step, so the same question points at the step
const stageQuestion = (c: { name: string, stage: boolean }) => `What is happening in the ${c.name} ${c.stage ? 'stage' : 'step'}?`
const askAt = (c: { id: string, stage: boolean }) => c.stage ? `stage:${c.id}` : c.id === 'other' || c.id === 'closed' ? undefined : `node:${c.id}`
const stageAsked = (c: { id: string, name: string, stage: boolean }) => asker.open.value && asker.focus.value === askAt(c) && asker.lastQuestion.value === stageQuestion(c)
const toast = useToast()
// up to this many, a step shows each person; above it, one pile and the way to the list (the board's preview size)
const CARDS = 30

// ---------- columns: stages (with what each does by itself), then steps no stage claims, then Closed ----------
const columns = computed(() => boardColumns(props.board).map(c => ({
  ...c,
  hint: c.stage && !c.rows.length ? 'No steps in this stage yet. Add them on the Flow tab.' : undefined,
  bolt: c.stage ? boltLine(props.graph, c.id, props.nameOf) : '',
})))
const rowLabel = (pos: Pos) => columns.value.flatMap(c => c.rows).find(r => r.id === posId(pos))?.label

const countAt = (pos: Pos) => props.board.counts.find(c => 'node' in pos
  ? c.status === 'active' && c.key === pos.node
  : c.status === 'closed' && c.outcome === pos.closed) ?? { n: 0, failed: 0, overdue: 0 }
const colTotal = (rows: Row[]) => rows.reduce((n, r) => n + countAt(r.pos).n, 0)
// a step with few enough people shows each of them; Closed is the record, so it stays a count
const asCards = (r: Row) => 'node' in r.pos && countAt(r.pos).n <= CARDS
const peopleAt = (pos: Pos) => (props.board.preview as ListRow[]).filter(r => posId(posOfRow(r) ?? { node: '' }) === posId(pos))
const personOf = (r: PipelineRow): Person => ({ id: r.id, name: fullName(r.candidate), email: r.candidate.email, at: posOfRow(r)! })
const late = (r: PipelineRow) => !!r.dueAt && new Date(r.dueAt).getTime() < Date.now()
const listLink = (r: Row) => ({ query: 'node' in r.pos ? { view: 'list', step: r.pos.node } : { view: 'list', show: r.pos.closed } })

// ---------- people pulled out of a pile by search; gone on reload, as everything groups again ----------
const picked = ref<Person[]>([])
const pickedAt = (pos: Pos) => picked.value.filter(p => posId(p.at) === posId(pos))
const groupN = (pos: Pos) => Math.max(0, countAt(pos).n - pickedAt(pos).length)
// the slot says who acts at this step, as everywhere else; "stopped" is said by its chip, in words
const slotOf = (r: Row) => 'closed' in r.pos ? (r.pos.closed === 'hired' ? 'ok' : 'line') : nodeMeta(r.type!).slot

// ---------- find: "Find a candidate" searches everyone; picking brings them into view ----------
const finder = ref<InstanceType<typeof BoardFindDialog>>()
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
const facesAt = (pos: Pos) => peopleAt(pos).filter(r => !picked.value.some(p => p.id === r.id)).slice(0, 3)

async function pick(r: PipelineRow) {
  const at = posOfRow(r)
  const name = fullName(r.candidate)
  const row = at && columns.value.flatMap(c => c.rows).find(x => x.id === posId(at))
  if (!at || !row) return toast.show(`${name} is at a step the board doesn’t show. Open them to move them.`)
  // in a pile they come out onto their own card; in a row of cards they're already there
  if (!asCards(row) && !picked.value.some(p => p.id === r.id)) picked.value.push(personOf(r))
  await nextTick()
  const el = document.querySelector<HTMLElement>(`[data-person="${r.id}"]`)
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  el?.focus({ preventScroll: true })
}
const unpick = (id: string) => (picked.value = picked.value.filter(p => p.id !== id))

// ---------- drag: every target says what dropping there means, the hovered one says what it sets off ----------
type Dragging = { kind: 'group', from: Pos } | { kind: 'person', person: Person }
const dragging = ref<Dragging | null>(null)
const over = ref<string | null>(null)
const fromOf = (d: Dragging) => d.kind === 'group' ? d.from : d.person.at
const canDrop = (r: Row) => {
  const d = dragging.value
  if (!d) return false
  const from = fromOf(d)
  return posId(from) !== r.id && !('closed' in from && 'closed' in r.pos)
}
const tagOf = (r: Row) => dragging.value && canDrop(r) ? dropTag(props.graph, fromOf(dragging.value), r.pos) : null
const draggedName = computed(() => {
  const d = dragging.value
  if (!d) return ''
  return d.kind === 'person' ? d.person.name : plural(groupN(d.from), 'person', 'people')
})
// the hovered target's preview floats over the board in fixed position, so no scrolling column clips it
const tip = ref<{ row: Row, left: number, top: number } | null>(null)
const tipLines = computed(() => {
  const d = dragging.value
  const t = tip.value
  if (!d || !t) return null
  const tag = dropTag(props.graph, fromOf(d), t.row.pos)
  const many = d.kind === 'group' && groupN(d.from) > 1
  const effects = dropEffects(props.graph, t.row.pos, props.nameOf, many)
  const rejecting = effects.some(e => e.outcome === 'rejected')
  return {
    effects,
    after: rejecting ? 'Asks you for a reason from your list.' : tag.kind === 'next' ? 'Follows the flow, so no reason needed.' : 'Asks you why, for their history.',
  }
})
// Where it floats: beside the row (right, then left), else inside the row under its own tag, never over
// another target's tag, because those tags are how a dragger compares the places they could drop.
const tipEl = ref<HTMLElement>()
function place(e: DragEvent, r: Row) {
  const row = e.currentTarget as HTMLElement
  const box = row.getBoundingClientRect()
  // ponytail: sized from the last preview shown (180 before the first); a much taller one can still graze a tag
  const W = 280, H = tipEl.value?.offsetHeight || 180
  const tags = [...document.querySelectorAll('.board .tag')].filter(t => !row.contains(t)).map(t => t.getBoundingClientRect())
  const spots = [box.right - 16, box.left - W + 16, box.left + 8]
    .map(left => ({ left: Math.min(Math.max(8, left), innerWidth - W - 8), top: Math.max(8, Math.min(box.top + 28, innerHeight - H - 8)) }))
  const clear = (s: { left: number, top: number }) => !tags.some(t => s.left < t.right && s.left + W > t.left && s.top < t.bottom && s.top + H > t.top)
  tip.value = { row: r, ...(spots.find(clear) ?? spots[2]!) }
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
  if (over.value !== r.id) place(e, r)
  over.value = r.id
}
function onDragLeave(e: DragEvent, r: Row) {
  // leaving for a child of the same row is not leaving
  if (over.value === r.id && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) over.value = null, tip.value = null
}
function onDrop(r: Row) {
  const d = dragging.value
  const ok = canDrop(r)
  onDragEnd()
  if (d && ok) ask(d, r)
}
const onDragEnd = () => (dragging.value = null, over.value = null, tip.value = null)

// ---------- moving: always through the confirm, which says what will happen ----------
const dlg = ref<InstanceType<typeof BoardMoveDialog>>()
function ask(d: Dragging, to?: Row) {
  const drop: Drop = d.kind === 'group'
    ? { parts: [{ from: d.from, except: pickedAt(d.from).map(p => p.id) }], fromLabel: rowLabel(d.from)!, seen: groupN(d.from), to: to ?? null }
    : { parts: [{ from: d.person.at, ids: [d.person.id] }], name: d.person.name, fromLabel: rowLabel(d.person.at)!, seen: 1, to: to ?? null }
  dlg.value!.open(drop)
}
// keyboard path: every row is a target in the dialog's picker
const targets = computed(() => columns.value.flatMap(c => c.rows.map(r => ({ ...r, group: c.name }))))

// Moving in the background: the source group drains as the queue works. Watch it, then stop.
const moving = ref<{ from: Pos, to: Pos, total: number, until: number, deadline: number } | null>(null)
let poll: ReturnType<typeof setInterval> | undefined
// The ending of a drag: the moved card arrives on a brief accent tint once the board has it in its new row.
const landing = ref<string[]>([])
const landed = ref(new Set<string>())
let landTimer: ReturnType<typeof setTimeout> | undefined
function onMoved(res: MoveResult) {
  landing.value = res.moved.map(m => m.id)
  for (const m of res.moved) {
    const p = picked.value.find(x => x.id === m.id)
    const at = m.status === 'closed' ? { closed: m.outcome as 'hired' } : m.currentNodeKey ? { node: m.currentNodeKey } : null
    if (p && at) p.at = at
  }
  emit('reload')
  const q = res.queued[0]
  if (!q) return
  moving.value = { from: q.from, to: q.to, total: q.n, until: Math.max(0, countAt(q.from).n - q.n), deadline: Date.now() + 120_000 }
  clearInterval(poll)
  // ponytail: polls the counts until the source drains; add a moves table if exact progress matters
  poll = setInterval(() => emit('reload'), 2000)
}
watch(() => props.board, () => {
  if (landing.value.length) {
    landed.value = new Set(landing.value)
    landing.value = []
    clearTimeout(landTimer)
    landTimer = setTimeout(() => (landed.value = new Set()), 600)
  }
  const m = moving.value
  if (m && (countAt(m.from).n <= m.until || Date.now() > m.deadline)) {
    clearInterval(poll)
    moving.value = null
  }
})
onBeforeUnmount(() => (clearInterval(poll), clearTimeout(landTimer)))
const movingLeft = computed(() => moving.value ? Math.max(0, countAt(moving.value.from).n - moving.value.until) : 0)
</script>

<template>
  <div class="board-wrap">
    <div class="tools">
      <button type="button" class="btn find-btn" @click="finder!.open()"><Icon name="search" :size="16" />Find a candidate</button>
      <p v-if="dragging" class="moving" role="status"><b>Moving {{ draggedName }}</b> from {{ rowLabel(fromOf(dragging)) }}</p>
      <p v-else-if="moving" class="moving" role="status">
        <span class="spinner" />Moving {{ movingLeft.toLocaleString() }} of {{ moving.total.toLocaleString() }} to {{ rowLabel(moving.to) }}
      </p>
    </div>

    <div class="board" :class="{ dragging }" role="list" aria-label="Pipeline by stage">
      <section
        v-for="c in columns" :key="c.id" class="col" :class="{ closed: c.id === 'closed', asked: stageAsked(c) }" role="listitem"
        :aria-labelledby="`col-${c.id}`" :data-ask="askAt(c)"
      >
        <header class="col-head">
          <div class="col-title">
            <h3 :id="`col-${c.id}`">{{ c.name }}</h3>
            <button
              v-if="canAsk && askAt(c)" type="button" class="ask-stage"
              @click="asker.ask(stageQuestion(c), askAt(c))"
            >Ask about this {{ c.stage ? 'stage' : 'step' }}</button>
            <span class="col-n">{{ colTotal(c.rows).toLocaleString() }}</span>
          </div>
          <p v-if="c.bolt" class="bolt">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
            <span><span class="sr-only">On its own: </span>{{ c.bolt }}</span>
          </p>
        </header>
        <p v-if="c.hint" class="col-hint">{{ c.hint }}</p>
        <div v-else class="rows">
          <div
            v-for="r in c.rows" :key="r.id" class="row" :class="[over === r.id && 'over', tagOf(r) && `t-${tagOf(r)!.kind}`]"
            @dragover="onDragOver($event, r)" @dragleave="onDragLeave($event, r)" @drop.prevent="onDrop(r)"
          >
            <span v-if="tagOf(r)" class="tag">{{ tagOf(r)!.text }}</span>
            <div v-if="c.rows.length > 1 || c.id === 'closed'" class="row-head">
              <Icon v-if="r.type" :name="nodeMeta(r.type).icon" :size="14" />{{ r.label }}
            </div>

            <!-- few enough: each person, as the mock; drag one, or press Move… -->
            <template v-if="asCards(r)">
              <article
                v-for="p in peopleAt(r.pos)" :key="p.id" class="pc" :class="{ lifted: dragging?.kind === 'person' && dragging.person.id === p.id, landed: landed.has(p.id) }"
                :data-person="p.id" tabindex="-1" :draggable="isManager"
                @dragstart="onDragStart($event, { kind: 'person', person: personOf(p) })" @dragend="onDragEnd"
              >
                <div class="pc-top">
                  <Avatar :name="fullName(p.candidate)" :size="24" />
                  <NuxtLink :to="`/candidates/${p.id}`" class="pc-name" draggable="false">{{ fullName(p.candidate) }}</NuxtLink>
                  <span v-if="p.score !== null" class="chip score" :title="`AI score ${Math.round(p.score)}`"><span class="sr-only">AI score </span>{{ Math.round(p.score) }}</span>
                </div>
                <div class="pc-meta">
                  <span v-if="p.source" class="src">{{ sourceLabel(p.source) }}</span>
                  <span v-if="p.since">{{ inStep(p.since) }}</span>
                  <span v-if="p.runStatus === 'failed'" class="chip chip-bad"><Icon name="stop" />Stopped</span>
                  <span v-else-if="late(p)" class="chip chip-warn"><Icon name="clock" />Late</span>
                  <button v-if="isManager" type="button" class="btn btn-quiet btn-icon btn-sm pc-move" :aria-label="`Move ${fullName(p.candidate)}…`" title="Move…" @click="ask({ kind: 'person', person: personOf(p) })"><Icon name="move" /></button>
                </div>
              </article>
              <button v-if="isManager && countAt(r.pos).n > 1" type="button" class="btn btn-quiet btn-sm all-move" @click="ask({ kind: 'group', from: r.pos })">
                <Icon name="move" />Move all {{ countAt(r.pos).n }}…
              </button>
            </template>

            <template v-else>
              <!-- people pulled out by search, or just moved: first, so they're never scrolled out of sight -->
              <article
                v-for="p in pickedAt(r.pos)" :key="p.id" class="card person" :class="{ landed: landed.has(p.id) }" :data-person="p.id" data-slot="accent" tabindex="-1"
                :draggable="isManager" @dragstart="onDragStart($event, { kind: 'person', person: p })" @dragend="onDragEnd"
              >
                <div class="p-top">
                  <NuxtLink :to="`/candidates/${p.id}`" class="p-name" draggable="false">{{ p.name }}</NuxtLink>
                  <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Put ${p.name} back in the pile`" title="Put back in the pile" @click="unpick(p.id)"><Icon name="x" :size="14" /></button>
                </div>
                <span class="p-email">{{ p.email }}</span>
                <button v-if="isManager" type="button" class="btn btn-quiet btn-sm p-move" @click="ask({ kind: 'person', person: p })"><Icon name="move" />Move…</button>
              </article>

              <!-- the pile: everyone here, as one stack of badges -->
              <article
                v-if="groupN(r.pos)" class="card group" :data-slot="slotOf(r)" :data-stack="groupN(r.pos) >= 10 ? 2 : groupN(r.pos) > 1 ? 1 : 0"
                :draggable="isManager" :aria-label="`${groupN(r.pos).toLocaleString()} at ${r.label}`"
                @dragstart="onDragStart($event, { kind: 'group', from: r.pos })" @dragend="onDragEnd"
              >
                <div class="g-top">
                  <div class="g-n"><b>{{ groupN(r.pos).toLocaleString() }}</b> {{ groupN(r.pos) === 1 ? 'person' : 'people' }}</div>
                  <button v-if="isManager" type="button" class="btn btn-quiet btn-sm g-move" :aria-label="`Move all ${groupN(r.pos).toLocaleString()} at ${r.label}…`" title="Move all…" @click="ask({ kind: 'group', from: r.pos })">
                    <Icon name="move" />Move…
                  </button>
                </div>
                <div v-if="countAt(r.pos).failed || countAt(r.pos).overdue" class="g-flags">
                  <span v-if="countAt(r.pos).failed" class="chip chip-bad"><Icon name="stop" />{{ countAt(r.pos).failed.toLocaleString() }} stopped</span>
                  <span v-if="countAt(r.pos).overdue" class="chip chip-warn"><Icon name="clock" />{{ countAt(r.pos).overdue.toLocaleString() }} late</span>
                </div>
                <NuxtLink :to="listLink(r)" class="g-see" draggable="false">
                  <span v-if="facesAt(r.pos).length" class="faces" aria-hidden="true">
                    <Avatar v-for="f in facesAt(r.pos)" :key="f.id" :name="fullName(f.candidate)" :size="24" />
                  </span>
                  See them in the list
                </NuxtLink>
              </article>
            </template>

            <p v-if="!countAt(r.pos).n && !pickedAt(r.pos).length" class="nobody">{{ dragging && canDrop(r) ? 'Drop here' : 'Nobody here' }}</p>
          </div>
        </div>
      </section>
    </div>

    <div v-if="tip && tipLines" ref="tipEl" class="tip" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }" aria-hidden="true">
      <b>Dropping {{ draggedName }} here</b>
      <ul>
        <li v-for="(e, i) in tipLines.effects" :key="i" :class="e.kind">{{ e.text }}</li>
      </ul>
      <p>{{ tipLines.after }}</p>
    </div>

    <BoardFindDialog ref="finder" :job-id="jobId" :label-of="rowLabel" :scopes="scopes" :preview="board.preview" @pick="pick" />
    <BoardMoveDialog ref="dlg" :job-id="jobId" :targets="targets" :graph="graph" :name-of="nameOf" @moved="onMoved" />
  </div>
</template>

<style scoped>
.board-wrap { display: grid; gap: 14px; min-width: 0; }
.tools { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; min-height: var(--h-md); }
.find-btn { min-width: 240px; justify-content: flex-start; color: var(--ink-2); }
.find-btn svg { color: var(--ink-3); }
.moving { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.moving b { color: var(--ink); font-weight: 600; }

/* columns scroll sideways inside the board; the page itself never does. The top padding leaves room for the tags. */
.board {
  display: grid; grid-auto-flow: column; grid-auto-columns: 264px; gap: 12px; align-items: stretch;
  overflow-x: auto; padding: 4px 0 8px; height: max(520px, calc(100dvh - 300px));
}
.col { display: flex; flex-direction: column; min-height: 0; border-radius: var(--r-panel); background: var(--sunk); }
.col.closed { background: none; box-shadow: inset 0 0 0 1px var(--line); }
.col-head { display: grid; gap: 8px; padding: 14px 14px 10px; }
.col-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.col-head h3 { font-size: var(--t-md); overflow-wrap: anywhere; }
.col.asked { box-shadow: inset 0 0 0 1.5px var(--ink); }
/* shows on hover and keyboard focus, and always on touch */
.ask-stage {
  margin-left: auto; height: 24px; padding: 0 9px; border: 0; border-radius: var(--r-pill); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2);
  font: 600 var(--t-xs) var(--font); color: var(--ink); white-space: nowrap; cursor: pointer; opacity: 0; transition: opacity var(--t-micro) var(--ease);
}
.col-head:hover .ask-stage, .col-head:focus-within .ask-stage, .col.asked .ask-stage { opacity: 1; }
@media (hover: none), (pointer: coarse) { .ask-stage { opacity: 1; } }
/* where it shows only on hover, it sits over the count so the title never reflows */
@media (hover: hover) and (pointer: fine) { .col-title { position: relative; } .ask-stage { position: absolute; right: 0; top: 50%; translate: 0 -50%; } }
.ask-stage:hover { background: var(--hover); }
.ask-stage:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.col-n { font-size: var(--t-sm); font-weight: 600; color: var(--ink-3); font-variant-numeric: tabular-nums; }
/* what the stage does by itself: a small slip on the column, the bolt in the accent because it acts for you */
.bolt { display: flex; align-items: flex-start; gap: 6px; padding: 5px 8px; border-radius: 8px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); font-size: var(--t-xs); line-height: 1.4; color: var(--ink-2); }
.bolt svg { flex: none; margin-top: 2px; color: var(--accent); }
.col-hint { padding: 0 14px 14px; font-size: var(--t-sm); color: var(--ink-2); }
.rows { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 12px 8px 8px; gap: 14px; }
.row {
  position: relative; display: flex; flex-direction: column; gap: 6px; min-height: 120px; padding: 10px; border-radius: 12px; flex: none;
  outline: 1.5px dashed transparent; outline-offset: -1.5px; transition: background var(--t-micro) var(--ease), outline-color var(--t-micro) var(--ease);
}
.row:last-child { flex: 1 0 auto; }
.row-head { display: flex; align-items: center; gap: 6px; font-size: var(--t-xs); font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--ink-2); padding: 0 2px; }
.row-head svg { flex: none; color: var(--ink-3); }
.nobody { margin: auto 0; text-align: center; font-size: var(--t-sm); color: var(--ink-3); }

/* drag hints: the flow's own next step in the accent; a skip in amber, worth a second look; the rest quiet */
.tag {
  position: absolute; top: -11px; left: 10px; z-index: 1; display: inline-flex; align-items: center; height: 22px; padding: 0 9px; max-width: calc(100% - 20px);
  border-radius: var(--r-pill); font-size: var(--t-xs); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: var(--surface); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line-2);
  animation: tag-in var(--t-micro) var(--ease);
}
@keyframes tag-in { from { opacity: 0; translate: 0 3px; } }
.row.t-back, .row.t-close, .row.t-other { outline-color: var(--line-2); }
.row.t-skip { outline-color: var(--warn); background: color-mix(in oklch, var(--warn-tint) 60%, transparent); }
.row.t-skip .tag { color: var(--warn); box-shadow: inset 0 0 0 1px var(--warn); }
.row.t-next { outline: 2px solid var(--accent); outline-offset: -2px; background: color-mix(in oklch, var(--accent-tint) 60%, transparent); }
.row.t-next .tag { background: var(--accent); color: #fff; box-shadow: none; }
.row.over { background: var(--accent-tint); }
.row.over:not(.t-next) { outline-style: solid; }
.row.over .nobody { color: var(--accent-ink); font-weight: 600; }

/* one person: a small white badge; the name is the link, the score sits at the end where the eye checks it */
.pc { position: relative; display: grid; gap: 4px; padding: 9px 10px 8px 12px; border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-1); min-width: 0; }
.pc[draggable="true"] { cursor: grab; }
.pc[draggable="true"]:active { cursor: grabbing; }
.pc:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pc.lifted { opacity: 0.4; outline: 2px dashed var(--ink-3); box-shadow: none; }
.pc-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pc-name { flex: 1; min-width: 0; font-weight: 600; font-size: var(--t-sm); color: var(--ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-name:hover { color: var(--accent-ink); text-decoration: underline; }
.score { flex: none; height: 20px; padding: 0 7px; }
.pc-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-height: 22px; padding: 0 22px 0 32px; font-size: var(--t-xs); color: var(--ink-2); }
.pc-meta > span:not(.chip) + span:not(.chip)::before { content: "·"; margin-right: 6px; color: var(--ink-3); }
.src { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* the keyboard's way to move one person: there on hover and focus, so thirty cards don't carry thirty buttons */
.pc-move { position: absolute; right: 4px; bottom: 4px; width: 26px; height: 26px; color: var(--ink-3); opacity: 0; transition: opacity var(--t-micro) var(--ease); }
.pc:hover .pc-move, .pc:focus-within .pc-move { opacity: 1; }
.all-move { align-self: flex-start; margin: 2px 0 0 -4px; }

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
/* faces and words are one link: the first three of the pile, then where it goes */
.g-see {
  white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; margin: 10px 0 0 -6px; padding: 4px 10px 4px 6px; border-radius: var(--r-pill);
  font-size: var(--t-sm); font-weight: 600; color: var(--accent-ink); text-decoration: none;
}
.g-see:hover { background: var(--hover); }
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

/* the drop preview: one card in the top layer of the page, beside the hovered target */
.tip {
  position: fixed; z-index: 40; width: 280px; display: grid; gap: 8px; padding: 14px; border-radius: var(--r-panel);
  background: var(--surface); box-shadow: var(--shadow-3); pointer-events: none; font-size: var(--t-sm);
  animation: tip-in var(--t-micro) var(--ease);
}
@keyframes tip-in { from { opacity: 0; scale: 0.97; } }
/* the landing: the moved card starts on the accent tint (the board's "you did this" colour) and settles to white
   in one transition step; under reduced motion the global 1 ms rule makes it a plain arrival */
.landed { animation: land var(--t-move) var(--ease); }
@keyframes land { from { background: var(--accent-tint); box-shadow: 0 0 0 2px var(--accent-line); } }
.tip ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.tip li { position: relative; padding-left: 16px; color: var(--ink); line-height: 1.4; }
.tip li::before { content: ""; position: absolute; left: 2px; top: 0.5em; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.tip li.auto::before, .tip li.close::before { background: var(--machine); }
.tip li.email { color: var(--bad); }
.tip li.email::before { background: var(--bad); }
.tip p { font-size: var(--t-xs); color: var(--ink-3); }
</style>
