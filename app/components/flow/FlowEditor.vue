<script setup lang="ts">
import { Background } from '@vue-flow/background'
import { ConnectionMode, MarkerType, VueFlow, useVueFlow, type Connection, type Edge, type Node } from '@vue-flow/core'
import { fieldsAvailableAt, validateVersion } from '~~/shared/workflow/graph'
import type { ConditionConfig } from '~~/shared/workflow/rules'
import type { Graph, GraphEdge, Issue } from '~~/shared/workflow/types'
import {
  GRID, PALETTE, type PaletteItem, type Person, type Role, branchKeys, branchLabel, cardWidth, freeSlot, issueText,
  layout, makeNode, reaches, spotBelow, summaryOf, titleOf,
} from '~/lib/flow'
import StepNode, { type StepData } from './StepNode.vue'
import StepPanel from './StepPanel.vue'

const props = defineProps<{ jobId: string }>()
const { detail, editable, saveDraft } = useJob(() => props.jobId)
const toast = useToast()
const route = useRoute()
const router = useRouter()
const { fitView, zoomIn, zoomOut, setCenter, setViewport, getViewport, findNode, project, updateNodeInternals, onNodesInitialized, dimensions } = useVueFlow()

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const wf = ref<Graph>(clone(editable.value!.workflow))
const form = computed(() => editable.value?.form ?? [])
const readOnly = computed(() => detail.value?.job.status === 'archived')
const liveKeys = computed(() => new Set(detail.value?.published?.workflow.nodes.map(n => n.key) ?? []))
const jobCtx = computed(() => ({ title: detail.value?.job.title ?? '', openings: detail.value?.job.openings ?? 1, requirements: detail.value?.job.requirements }))
const reduced = import.meta.client && matchMedia('(prefers-reduced-motion: reduce)').matches
const ms = (n: number) => (reduced ? 0 : n)

// ---------- people to assign ----------
const roles = ref<Role[]>([])
const people = ref<Person[] | null>(null)
api<Role[]>('/api/roles').then(r => (roles.value = r)).catch(() => {})
api<Person[]>('/api/users/assignable').then(r => (people.value = r)).catch(() => {})

// ---------- validation, history, autosave: all follow the local graph ----------
const issues = ref<Issue[]>(validateVersion(form.value, wf.value))
const issuesBy = computed(() => {
  const m = new Map<string, Issue[]>()
  for (const i of issues.value) if (i.node) m.set(i.node, [...(m.get(i.node) ?? []), i])
  return m
})
let validateTimer: ReturnType<typeof setTimeout> | undefined
watch(form, () => (issues.value = validateVersion(form.value, wf.value)))

const undoStack: string[] = []
const redoStack: string[] = []
const canUndo = ref(false)
const canRedo = ref(false)
let last = JSON.stringify(wf.value)
let restoring = false
let historyTimer: ReturnType<typeof setTimeout> | undefined
function record() {
  clearTimeout(historyTimer)
  const now = JSON.stringify(wf.value)
  if (now === last) return
  undoStack.push(last)
  if (undoStack.length > 100) undoStack.shift()
  redoStack.length = 0
  last = now
  canUndo.value = true
  canRedo.value = false
}
function restore(s: string) {
  restoring = true
  wf.value = JSON.parse(s)
  last = s
  canUndo.value = undoStack.length > 0
  canRedo.value = redoStack.length > 0
}
function undo() {
  record()
  const prev = undoStack.pop()
  if (prev === undefined) return
  redoStack.push(last)
  restore(prev)
}
function redo() {
  record()
  const next = redoStack.pop()
  if (next === undefined) return
  undoStack.push(last)
  restore(next)
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
const saveState = ref<SaveState>('idle')
const saveError = ref('')
let saveTimer: ReturnType<typeof setTimeout> | undefined
let inFlight = false
let again = false
const dirty = ref(false)
async function save() {
  clearTimeout(saveTimer)
  if (inFlight) return void (again = true)
  inFlight = true
  saveState.value = 'saving'
  dirty.value = false
  try {
    await saveDraft({ workflow: clone(wf.value) })
    saveState.value = 'saved'
  }
  catch (e) {
    // the local graph stays as it is; Retry sends it again
    dirty.value = true
    saveState.value = 'error'
    saveError.value = (e as ApiError).message ?? toApiError(e).message
  }
  finally {
    inFlight = false
    if (again) again = false, save()
  }
}

watch(wf, () => {
  clearTimeout(validateTimer)
  validateTimer = setTimeout(() => (issues.value = validateVersion(form.value, wf.value)), 150)
  if (readOnly.value) return
  dirty.value = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 800)
  if (restoring) return void (restoring = false)
  clearTimeout(historyTimer)
  historyTimer = setTimeout(record, 400)
}, { deep: true })

const onUnload = (e: BeforeUnloadEvent) => { if (dirty.value) e.preventDefault() }
onMounted(() => window.addEventListener('beforeunload', onUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onUnload)
  if (dirty.value && !readOnly.value) save()
})

// ---------- selection lives in the URL (?node=key), so the hub's Publish problems can link to a step ----------
const selectedKey = computed(() => {
  const k = route.query.node
  return typeof k === 'string' && wf.value.nodes.some(n => n.key === k) ? k : null
})
const selected = computed(() => wf.value.nodes.find(n => n.key === selectedKey.value) ?? null)
const selectedEdge = ref<string | null>(null)
function select(key: string | null) {
  selectedEdge.value = null
  if (key === selectedKey.value) return
  router.replace({ query: { ...route.query, node: key ?? undefined } })
}

// ---------- what Vue Flow draws ----------
const auto = computed(() => wf.value.nodes.every(n => n.position) ? null : layout(wf.value))
const posOf = (key: string) => wf.value.nodes.find(n => n.key === key)?.position ?? auto.value?.get(key) ?? { x: 0, y: 0 }

const edgeId = (e: GraphEdge) => `${e.from}>${e.to}>${e.branch ?? ''}`
const vfNodes = computed<Node<StepData>[]>(() => wf.value.nodes.map((n) => {
  const meta = nodeMeta(n.type)
  const out = wf.value.edges.filter(e => e.from === n.key)
  return {
    id: n.key,
    type: 'step',
    position: posOf(n.key),
    draggable: !readOnly.value,
    connectable: !readOnly.value,
    data: {
      type: n.type,
      noun: meta.noun,
      icon: meta.icon,
      slot: n.type === 'end' ? ((n.config as any)?.outcome === 'hired' ? 'ok' : 'line') : meta.slot,
      title: titleOf(n),
      summary: summaryOf(n, form.value, roles.value),
      width: cardWidth(n),
      issues: issuesBy.value.get(n.key)?.length ?? 0,
      selected: n.key === selectedKey.value,
      readOnly: readOnly.value,
      branches: n.type === 'condition' ? branchKeys(n).map(b => ({ key: b, label: branchLabel(n, b), linked: out.some(e => e.branch === b) })) : null,
    },
  }
}))
const keys = computed(() => new Set(wf.value.nodes.map(n => n.key)))
const vfEdges = computed<Edge[]>(() => wf.value.edges.filter(e => keys.value.has(e.from) && keys.value.has(e.to)).map((e) => {
  const id = edgeId(e)
  const sel = id === selectedEdge.value
  return {
    id,
    source: e.from,
    target: e.to,
    sourceHandle: e.branch ?? null,
    type: 'smoothstep',
    class: sel ? 'is-selected' : undefined,
    interactionWidth: 24,
    pathOptions: { offset: 44, borderRadius: 14 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: sel ? '#c0287a' : '#6c5e67' },
  }
}))

// a decision's handles change with its branches; Vue Flow measures handles only when told
const handleSig = computed(() => wf.value.nodes.filter(n => n.type === 'condition').map(n => `${n.key}:${branchKeys(n).join(',')}`).join('|'))
watch(handleSig, () => nextTick(() => updateNodeInternals()))

// ---------- rules, enforced while connecting ----------
const typeOf = (k: string) => wf.value.nodes.find(n => n.key === k)?.type
function canConnect(from: string, to: string) {
  if (readOnly.value || from === to) return false
  if (typeOf(to) === 'application_received' || typeOf(from) === 'end' || !typeOf(to)) return false
  return !reaches(wf.value, to, from) // no loops
}
const isValidConnection = (c: Connection) => canConnect(c.source, c.target)

// One way out per step (per branch for decisions): a new link replaces the old one, and says so.
function connect(from: string, to: string, branch?: string) {
  const fromNode = wf.value.nodes.find(n => n.key === from)!
  const same = (e: GraphEdge) => e.from === from && (fromNode.type !== 'condition' || e.branch === branch)
  const old = wf.value.edges.find(same)
  if (!to) {
    wf.value.edges = wf.value.edges.filter(e => !same(e))
    return
  }
  if (!canConnect(from, to)) return
  if (old?.to === to) return
  record()
  wf.value.edges = [...wf.value.edges.filter(e => !same(e)), { from, to, ...(fromNode.type === 'condition' && branch ? { branch } : {}) }]
  if (old) {
    const lbl = branch ? `“${branchLabel(fromNode, branch)}” now` : `“${titleOf(fromNode)}” now`
    toast.show(`${lbl} leads to “${titleOf(wf.value.nodes.find(n => n.key === to)!)}” instead`, { label: 'Undo', run: undo })
  }
}
const onConnect = (c: Connection) => connect(c.source, c.target, c.sourceHandle ?? undefined)

// ---------- add, move, rename, delete ----------
// Before placing anything by hand, pin every step where the automatic layout put it, so nothing jumps.
function pinPositions() {
  if (!auto.value) return
  const pos = auto.value
  for (const n of wf.value.nodes) n.position ??= { ...pos.get(n.key)! }
}

const canvasEl = ref<HTMLElement>()
function addStep(item: PaletteItem, at?: { x: number, y: number }) {
  if (readOnly.value) return
  record()
  pinPositions()
  const node = makeNode(item, wf.value, form.value)
  const sel = selected.value
  const w = cardWidth(node)
  if (at) node.position = { x: Math.round((at.x - w / 2) / GRID) * GRID, y: Math.round(at.y / GRID) * GRID }
  else if (sel) node.position = spotBelow(wf.value, sel, w)
  else {
    const r = canvasEl.value!.getBoundingClientRect()
    const c = project({ x: r.width / 2, y: r.height / 2 })
    node.position = { x: Math.round((c.x - w / 2) / GRID) * GRID, y: Math.round((c.y - 50) / GRID) * GRID }
  }
  wf.value.nodes.push(node)
  const slot = !at && sel ? freeSlot(wf.value, sel) : undefined
  if (sel && slot !== undefined && canConnect(sel.key, node.key)) {
    wf.value.edges.push({ from: sel.key, to: node.key, ...(slot ? { branch: slot } : {}) })
  }
  // a new decision starts from a real field of the steps before it, so it is valid at once
  if (node.type === 'condition') {
    const fields = fieldsAvailableAt(wf.value, node.key, form.value)
    const f = [...fields].reverse().find(x => x.type === 'number' && x.path.startsWith('nodes.')) ?? fields.find(x => x.type === 'number')
    if (f) (node.config as ConditionConfig).branches[0]!.rule = { ref: f.path, op: 'gte', value: 70 }
  }
  select(node.key)
  focusStep(node.key)
}

function onDragStart(e: DragEvent, item: PaletteItem) {
  e.dataTransfer!.setData('application/x-step', item.id)
  e.dataTransfer!.effectAllowed = 'copy'
}
function onDrop(e: DragEvent) {
  const id = e.dataTransfer?.getData('application/x-step')
  const item = PALETTE.flatMap(g => g.items).find(i => i.id === id)
  if (!item) return
  const r = canvasEl.value!.getBoundingClientRect()
  const p = project({ x: e.clientX - r.left, y: e.clientY - r.top })
  selectedEdge.value = null
  addStep(item, p)
}

function onDragStop({ nodes }: { nodes: { id: string, position: { x: number, y: number } }[] }) {
  pinPositions()
  for (const d of nodes) {
    const n = wf.value.nodes.find(x => x.key === d.id)
    if (n) n.position = { x: Math.round(d.position.x), y: Math.round(d.position.y) }
  }
}

// Renaming a key rewrites the links and every {{nodes.old.…}} reference, so nothing breaks quietly.
function renameNode(next: string) {
  const old = selectedKey.value!
  record()
  const rx = new RegExp(`\\bnodes\\.${old}\\.`, 'g')
  for (const n of wf.value.nodes) {
    if (n.key === old) n.key = next
    n.config = JSON.parse(JSON.stringify(n.config ?? {}).replace(rx, `nodes.${next}.`))
  }
  for (const e of wf.value.edges) {
    if (e.from === old) e.from = next
    if (e.to === old) e.to = next
  }
  select(next)
}

function removeNode(key: string) {
  const n = wf.value.nodes.find(x => x.key === key)
  if (!n || n.type === 'application_received' || readOnly.value) return
  record()
  wf.value.nodes = wf.value.nodes.filter(x => x.key !== key)
  wf.value.edges = wf.value.edges.filter(e => e.from !== key && e.to !== key)
  record()
  select(null)
  toast.show(`Deleted “${titleOf(n)}”`, { label: 'Undo', run: undo })
}
function removeEdge(id: string) {
  if (readOnly.value) return
  record()
  wf.value.edges = wf.value.edges.filter(e => edgeId(e) !== id)
  record()
  selectedEdge.value = null
  toast.show('Removed the link', { label: 'Undo', run: undo })
}

// ---------- viewport ----------
const MIN_ZOOM_ON_LOAD = 0.8
async function focusStep(key: string) {
  await nextTick()
  // the panel may just have opened and narrowed the canvas; let Vue Flow measure first
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const node = wf.value.nodes.find(n => n.key === key)
    if (!node) return
    const p = posOf(key)
    const dim = findNode(key)?.dimensions
    setCenter(p.x + (dim?.width || cardWidth(node)) / 2, p.y + (dim?.height || 100) / 2, { zoom: Math.max(getViewport().zoom, 0.85), duration: ms(260) })
  }))
}

// Fit on load; a long flow fitted that small is unreadable, so then start at the top at a readable size.
async function fitOnLoad() {
  await fitView({ padding: 0.12, maxZoom: 1 })
  const { zoom } = getViewport()
  if (zoom < MIN_ZOOM_ON_LOAD) {
    const ps = wf.value.nodes.map(n => posOf(n.key))
    const xs = wf.value.nodes.map(n => [posOf(n.key).x, posOf(n.key).x + cardWidth(n)]).flat()
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2
    await setViewport({ x: dimensions.value.width / 2 - mid * MIN_ZOOM_ON_LOAD, y: 56 - Math.min(...ps.map(p => p.y)) * MIN_ZOOM_ON_LOAD, zoom: MIN_ZOOM_ON_LOAD })
  }
}
// fires again whenever a new step gets measured; only the first time is "load"
let loaded = false
onNodesInitialized(async () => {
  if (loaded) return
  loaded = true
  await fitOnLoad()
  if (selectedKey.value) focusStep(selectedKey.value)
})

// ---------- keyboard: everything a drag does, without one ----------
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z' && !typing(e.target)) {
    e.preventDefault()
    return e.shiftKey ? redo() : undo()
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing(e.target)) return e.preventDefault(), redo()
  if (typing(e.target) || document.querySelector(':popover-open, dialog[open]')) return
  if (e.key === 'Escape' && (selectedKey.value || selectedEdge.value)) return select(null)
  const onStep = (e.target as HTMLElement).closest?.('.vue-flow__node') as HTMLElement | null
  if (e.key === 'Enter' && onStep?.dataset.id) return e.preventDefault(), select(onStep.dataset.id)
  const inCanvas = e.target === document.body || !!canvasEl.value?.contains(e.target as HTMLElement)
  if ((e.key === 'Delete' || e.key === 'Backspace') && inCanvas) {
    if (selectedEdge.value) return e.preventDefault(), removeEdge(selectedEdge.value)
    const k = onStep?.dataset.id ?? selectedKey.value
    if (k) return e.preventDefault(), removeNode(k)
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// ---------- height: everything under the hub header ----------
const root = ref<HTMLElement>()
const height = ref(560)
const pullUp = ref(0)
function measure() {
  if (!root.value) return
  height.value = Math.max(560, window.innerHeight - (root.value.getBoundingClientRect().top + window.scrollY))
  // a parent's bottom padding would make the page scroll by that much; pull it in under us instead
  requestAnimationFrame(() => {
    const extra = document.documentElement.scrollHeight - window.innerHeight + pullUp.value
    pullUp.value = extra > 0 && extra < 120 ? extra : 0
  })
}
onMounted(() => {
  measure()
  requestAnimationFrame(measure)
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => window.removeEventListener('resize', measure))

// ---------- problems ----------
const problemsMenu = ref<HTMLElement>()
const problemList = computed(() => issues.value.map(i => {
  const n = wf.value.nodes.find(x => x.key === i.node)
  return { node: n?.key, where: n ? titleOf(n) : 'Whole flow', text: issueText(i, wf.value) }
}))
function goTo(key?: string) {
  problemsMenu.value?.hidePopover()
  if (!key) return
  select(key)
  focusStep(key)
}
</script>

<template>
  <div ref="root" class="flow" :class="{ 'has-panel': !!selected, 'read-only': readOnly }" :style="{ height: `${height}px`, marginBottom: `${-pullUp}px` }">
    <nav v-if="!readOnly" class="palette" aria-label="Add a step">
      <p class="pal-hint">Click to add under the selected step, or drag onto the canvas.</p>
      <section v-for="g in PALETTE" :key="g.group">
        <h3 class="eyebrow">{{ g.group }}</h3>
        <button
          v-for="item in g.items" :key="item.id" type="button" class="pal-item" draggable="true" :title="item.label"
          :data-slot-color="item.type === 'human_task' ? 'accent' : ['cv_parse', 'ai_review', 'send_email'].includes(item.type) ? 'ink' : item.outcome === 'hired' ? 'ok' : 'line'"
          @click="addStep(item)" @dragstart="onDragStart($event, item)"
        >
          <Icon :name="item.icon" :size="16" /><span class="pal-label">{{ item.label }}</span>
        </button>
      </section>
    </nav>

    <div ref="canvasEl" class="canvas" @dragover.prevent @drop.prevent="onDrop">
      <VueFlow
        :nodes="vfNodes" :edges="vfEdges" :min-zoom="0.2" :max-zoom="1.6"
        :nodes-draggable="!readOnly" :nodes-connectable="!readOnly" :elements-selectable="false"
        :connection-mode="ConnectionMode.Strict" :is-valid-connection="isValidConnection"
        :delete-key-code="null" :snap-to-grid="true" :snap-grid="[GRID, GRID]"
        :connection-line-options="{ type: 'smoothstep' as any }"
        @connect="onConnect" @node-click="({ node }) => select(node.id)" @pane-click="select(null)"
        @edge-click="({ edge }) => { select(null); selectedEdge = edge.id }"
        @node-drag-stop="onDragStop"
      >
        <template #node-step="p">
          <StepNode v-bind="p" />
        </template>
        <!-- dots on the snap grid: steps snap to them, and they show the canvas moving when you pan -->
        <Background variant="dots" :gap="GRID" :size="1.2" color="oklch(0.89 0.008 330)" />
      </VueFlow>

      <div class="toolbar" role="toolbar" aria-label="Canvas">
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Zoom out" title="Zoom out" @click="zoomOut({ duration: ms(160) })"><Icon name="zoom-out" /></button>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Zoom in" title="Zoom in" @click="zoomIn({ duration: ms(160) })"><Icon name="zoom-in" /></button>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Fit the whole flow" title="Fit the whole flow" @click="fitView({ padding: 0.12, duration: ms(260) })"><Icon name="fit" /></button>
        <template v-if="!readOnly">
          <span class="sep" />
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="!canUndo" aria-label="Undo" title="Undo (⌘Z)" @click="undo"><Icon name="reopen" /></button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="!canRedo" aria-label="Redo" title="Redo (⇧⌘Z)" @click="redo"><Icon name="reopen" class="flip" /></button>
        </template>
        <span class="sep" />
        <span v-if="readOnly" class="locked" role="status"><Icon name="lock" :size="14" />Archived: read-only</span>
        <button v-else-if="issues.length" type="button" class="btn btn-sm problems-btn" popovertarget="flow-problems">
          <Icon name="alert" />{{ issues.length }} problem{{ issues.length === 1 ? '' : 's' }}
        </button>
        <span v-else class="ready"><Icon name="check" :size="14" />Ready to publish</span>
        <span v-if="!readOnly" class="save" aria-live="polite">
          <template v-if="saveState === 'saving'"><span class="spinner" />Saving…</template>
          <template v-else-if="saveState === 'saved'">Saved</template>
          <template v-else-if="saveState === 'error'">
            <span class="save-err">Not saved: {{ saveError }}</span>
            <button type="button" class="btn btn-sm" @click="save">Retry</button>
          </template>
        </span>
      </div>

      <div id="flow-problems" ref="problemsMenu" popover class="menu problems-menu">
        <div class="pm-head eyebrow">Fix these before you publish</div>
        <button v-for="(p, i) in problemList" :key="i" type="button" :disabled="!p.node" @click="goTo(p.node)">
          <span class="pm-where">{{ p.where }}</span>
          <span class="pm-text">{{ p.text }}</span>
        </button>
      </div>
    </div>

    <StepPanel
      v-if="selected" :key="selected.key" class="side" :node="selected" :graph="wf" :form="form" :roles="roles" :people="people"
      :issues="issuesBy.get(selected.key) ?? []" :key-locked="liveKeys.has(selected.key)" :read-only="readOnly"
      :job-id="jobId" :job="jobCtx"
      @rename="renameNode" @connect="(b, to) => connect(selected!.key, to, b)" @remove="removeNode(selected!.key)" @close="select(null)"
    />
  </div>
</template>

<style scoped>
.flow {
  display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 560px; min-width: 0;
  border-top: 1px solid var(--line); background: var(--surface);
}
.flow.has-panel { grid-template-columns: 220px minmax(0, 1fr) 380px; }
.flow.read-only { grid-template-columns: minmax(0, 1fr); }
.flow.read-only.has-panel { grid-template-columns: minmax(0, 1fr) 380px; }

.palette { overflow-y: auto; padding: 14px 12px 24px; border-right: 1px solid var(--line); background: var(--surface); display: grid; align-content: start; gap: 16px; }
.pal-hint { font-size: var(--t-xs); color: var(--ink-2); padding: 0 6px; }
.palette section { display: grid; gap: 2px; }
.palette h3 { padding: 0 8px 4px; }
.pal-item {
  position: relative; display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 6px 8px 6px 10px; border: 0; border-radius: 10px;
  background: none; text-align: left; font-weight: 500; color: var(--ink); cursor: grab;
}
.pal-item:hover { background: var(--hover); }
.pal-item:active { cursor: grabbing; }
.pal-item svg { flex: none; color: var(--ink-2); }
/* the badge slot, turned sideways: who acts in this kind of step */

/* narrow screens with a step open: the palette folds to icons so the canvas keeps room */
@media (width < 1360px) {
  .flow.has-panel:not(.read-only) { grid-template-columns: 60px minmax(0, 1fr) 350px; }
  .has-panel .palette { padding: 12px 8px; gap: 10px; }
  .has-panel .pal-hint, .has-panel .pal-label, .has-panel .palette h3 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .has-panel .palette section + section { border-top: 1px solid var(--line); padding-top: 10px; }
  .has-panel .pal-item { justify-content: center; padding: 8px; }
}

.canvas { position: relative; min-width: 0; min-height: 0; background: var(--bg); }
.side { min-width: 0; min-height: 0; }

.toolbar {
  position: absolute; z-index: 5; left: 14px; top: 14px; display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  max-width: calc(100% - 28px); padding: 4px; border-radius: var(--r-pill); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-2);
}
.sep { width: 1px; height: 18px; margin: 0 4px; background: var(--line); }
.flip { scale: -1 1; }
.problems-btn { --b-fg: var(--bad); --b-bg: var(--bad-tint); --b-ring: transparent; }
.locked { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.ready { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; font-size: var(--t-sm); font-weight: 600; color: var(--ok); }
.save { display: inline-flex; align-items: center; gap: 8px; padding: 0 10px 0 6px; font-size: var(--t-sm); color: var(--ink-2); }
.save-err { color: var(--bad); font-weight: 500; max-width: 28ch; }
.problems-menu {
  inset: auto; position-anchor: --flow-problems; position-area: block-end span-inline-end; margin-top: 8px;
  width: 380px; max-height: 60dvh; overflow-y: auto;
}
.pm-head { padding: 6px 10px 8px; }
.problems-menu button { display: grid; gap: 1px; align-items: start; }
.problems-menu button:disabled { cursor: default; }
.pm-where { font-weight: 600; }
.pm-text { color: var(--ink-2); font-size: var(--t-sm); font-weight: 500; }
.problems-btn { anchor-name: --flow-problems; }
</style>

<!-- Vue Flow's own CSS is unlayered, so these overrides are too (and not scoped: they reach its inner elements). -->
<style>
.flow .vue-flow__node { border-radius: 16px; }
.flow .vue-flow__node:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--r-card); }
.flow .vue-flow__edge-path, .flow .vue-flow__connection-path { stroke: var(--ink-2); stroke-width: 1.5; }
.flow .vue-flow__edge.is-selected .vue-flow__edge-path { stroke: var(--accent); stroke-width: 2.5; }
.flow .vue-flow__edge:hover .vue-flow__edge-path { stroke: var(--ink); }
.flow .vue-flow__connection-path { stroke: var(--accent); stroke-dasharray: 5 4; }
.flow .vue-flow__handle {
  width: 13px; height: 13px; min-width: 0; min-height: 0; border: 2px solid var(--surface); border-radius: 50%;
  background: var(--ink-2); box-shadow: 0 0 0 1px var(--line-2);
}
/* a bigger, invisible target around each handle */
.flow .vue-flow__handle::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; }
.flow .vue-flow__handle:hover, .flow .vue-flow__handle.connecting { background: var(--accent); }
.flow .vue-flow__handle.connectionindicator { cursor: crosshair; }
.flow .vue-flow__handle.valid { background: var(--ok); box-shadow: 0 0 0 4px var(--ok-tint); }
.flow.read-only .vue-flow__handle { opacity: 0; pointer-events: none; }
/* an arriving line clips into the card's slot like a lanyard into a badge; the top handle shows when it's useful */
.flow .vue-flow__handle-top { opacity: 0; transition: opacity var(--t-micro) var(--ease); }
.flow .vue-flow__node:hover .vue-flow__handle-top, .flow:has(.vue-flow__connection-path) .vue-flow__handle-top { opacity: 1; }
</style>
