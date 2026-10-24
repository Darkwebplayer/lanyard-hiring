<script setup lang="ts">
import { Background } from '@vue-flow/background'
import { ConnectionMode, MarkerType, VueFlow, useVueFlow, type Connection, type Edge, type Node } from '@vue-flow/core'
import { fieldsAvailableAt, validateVersion } from '~~/shared/workflow/graph'
import type { ConditionConfig } from '~~/shared/workflow/rules'
import { insertAfter, removeStep, stageView } from '~~/shared/workflow/stages'
import type { FormField, Graph, GraphEdge, Issue } from '~~/shared/workflow/types'
import { resting } from '~/lib/board'
import {
  GRID, blankNoun, buildPalette, type PaletteItem, type Person, type Preset, type Role, branchKeys, branchLabel, cardWidth, freeSlot, insertBefore, issueText,
  layout, makeNode, reaches, removeBlocker, spotBelow, summaryOf, titleOf,
} from '~/lib/flow'
import type { FlowSource } from '~/composables/useFlowSource'
import DescribeFlow from './DescribeFlow.vue'
import FlowPresetsMenu from './FlowPresetsMenu.vue'
import StepNode, { STAGE_ACTIONS, type StepData } from './StepNode.vue'
import StageList from './StageList.vue'
import StagesPanel from './StagesPanel.vue'
import StepPanel from './StepPanel.vue'

// stagesFirst: open on the stage list (a job's Stages tab); the canvas is the advanced view, at ?view=canvas
const props = defineProps<{ source: FlowSource, stagesFirst?: boolean }>()
const emit = defineEmits<{ edit: [], replace: [next: { form: FormField[], workflow: Graph }, name: string] }>()
const toast = useToast()
const route = useRoute()
const router = useRouter()
const { fitView, zoomIn, zoomOut, setCenter, setViewport, getViewport, findNode, project, updateNodeInternals, onNodesInitialized, dimensions } = useVueFlow()

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const wf = ref<Graph>(clone(props.source.workflow.value!))
const form = computed(() => props.source.form.value ?? [])
const readOnly = computed(() => props.source.readOnly.value)
const isJob = props.source.kind === 'job'
const reduced = import.meta.client && matchMedia('(prefers-reduced-motion: reduce)').matches
const ms = (n: number) => (reduced ? 0 : n)

// ---------- describe your flow: state (the steps are under "problems") ----------
const { canAsk: aiOn } = useMe()
const description = ref('')
// the draft the server sent back, shown unsaved; `before` is the graph to put back on Discard
const aiDraft = ref<{ summary: string, before: Graph } | null>(null)
const startedEmpty = ref(false) // "Start empty" puts the card away for this visit
const isEmpty = computed(() => wf.value.nodes.every(n => n.type === 'application_received'))
const describeInline = computed(() => aiOn.value && !readOnly.value && isEmpty.value && !startedEmpty.value && !aiDraft.value)
let quiet = false

// ---------- people to assign ----------
const roles = ref<Role[]>([])
const people = ref<Person[] | null>(null)
api<Role[]>('/api/roles').then(r => (roles.value = r)).catch(() => {})
api<Person[]>('/api/users/assignable').then(r => (people.value = r)).catch(() => {})

// ---------- palette: the company's presets, then the blank steps ----------
const { presets, error: presetsError, refresh: refreshPresets, update: updatePreset, reorder: reorderPresets, create: createPreset, remove: removePreset } = usePresets()
if (!presets.value) refreshPresets()
const palette = computed(() => buildPalette(presets.value ?? []))
// Edit mode: hide, reorder and bring back presets. Each change saves at once and reaches every job's palette.
const editing = ref(false)
function toggleEditing() {
  editing.value = !editing.value
  if (editing.value) select(null) // the palette needs its full width
}
const sectionPresets = (key: string) => {
  const types = palette.value.find(g => g.key === key)!.items.map(i => i.type)
  return (presets.value ?? []).filter(p => types.includes(p.type)).sort((a, b) => a.position - b.position)
}
const hiddenIn = (key: string) => sectionPresets(key).filter(p => !p.inPalette)
async function setShown(p: { id: string, label: string }, shown: boolean, undo = true) {
  // keyboard users keep their place: focus moves to the next row's first button (the hidden row is gone)
  const row = document.activeElement?.closest('.pal-row')
  const next = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null
  try {
    await updatePreset(p.id, { inPalette: shown })
    await nextTick()
    next?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    if (undo && !shown) toast.show(`Hid “${p.label}” from the palette`, { label: 'Undo', run: () => setShown(p, true, false) })
  }
  catch (e) { toast.show((e as ApiError).message) }
}
// Moves a visible preset past its visible neighbour; hidden presets keep their places in between.
async function movePreset(key: string, item: PaletteItem, by: -1 | 1) {
  const all = sectionPresets(key)
  const shown = all.filter(p => p.inPalette)
  const i = shown.findIndex(p => p.id === item.presetId)
  const other = shown[i + by]
  if (!other) return
  const ids = all.map(p => p.id)
  const a = ids.indexOf(item.presetId!), b = ids.indexOf(other.id)
  ;[ids[a], ids[b]] = [ids[b]!, ids[a]!]
  try {
    await reorderPresets(key, ids)
    // follow the moved row; at an edge its pressed arrow is disabled, so take the other one
    await nextTick()
    const moved = document.querySelector<HTMLElement>(`[data-preset="${item.presetId}"]`)
    ;(moved?.querySelector<HTMLElement>(`button[data-dir="${by}"]:not(:disabled)`) ?? moved?.querySelector<HTMLElement>('button[data-dir]:not(:disabled)'))?.focus()
  }
  catch (e) { toast.show((e as ApiError).message) }
}
const isFirstShown = (key: string, item: PaletteItem) => sectionPresets(key).find(p => p.inPalette)?.id === item.presetId
const isLastShown = (key: string, item: PaletteItem) => sectionPresets(key).filter(p => p.inPalette).at(-1)?.id === item.presetId

// A step tuned in this flow becomes a preset for every job.
async function saveAsPreset(key: string) {
  const n = wf.value.nodes.find(x => x.key === key)
  if (!n) return
  try {
    const p: Preset = await createPreset({ type: n.type, label: titleOf(n), config: clone(n.config) })
    toast.show(`Saved “${p.label}”. It’s now in every job’s palette.`, { label: 'Undo', run: () => removePreset(p.id).catch(() => {}) }, 8000)
  }
  catch (e) { toast.show((e as ApiError).message) }
}

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
let pending: Promise<void> = Promise.resolve()
const dirty = ref(false)
function save() {
  clearTimeout(saveTimer)
  if (inFlight) return void (again = true)
  inFlight = true
  saveState.value = 'saving'
  dirty.value = false
  pending = (async () => {
    try {
      await props.source.save({ workflow: clone(wf.value) })
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
  })()
}

// Sends any pending edit now and waits for every save in flight, so the server holds exactly this graph
// (before the page replaces the draft, or saves it as a preset). Throws if it couldn't be saved.
async function flush() {
  clearTimeout(historyTimer)
  if (dirty.value && !readOnly.value) save()
  while (inFlight) await pending
  if (saveState.value === 'error') throw { status: 0, code: 'not_saved', message: saveError.value, issues: [] } satisfies ApiError
  dirty.value = false // nothing left for the unmount save
}
defineExpose({ flush })
const presetSource = async () => {
  await flush()
  return { form: clone(form.value), workflow: clone(wf.value) }
}

watch(wf, () => {
  clearTimeout(validateTimer)
  validateTimer = setTimeout(() => (issues.value = validateVersion(form.value, wf.value)), 150)
  if (readOnly.value) return
  // a draft from a description stays unsaved until Save flow; a discarded one puts back what the server already has
  if (quiet) quiet = false
  else if (!aiDraft.value) {
    dirty.value = true
    emit('edit')
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 800)
  }
  if (restoring) return void (restoring = false)
  clearTimeout(historyTimer)
  historyTimer = setTimeout(record, 400)
}, { deep: true })

const onUnload = (e: BeforeUnloadEvent) => { if (dirty.value || aiDraft.value) e.preventDefault() }
onMounted(() => window.addEventListener('beforeunload', onUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onUnload)
  // a deleted preset has nowhere to save to; a second 404 would only repeat what the page says
  if (dirty.value && !readOnly.value && !props.source.missing.value) save()
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

// ---------- which view: the stage list when the flow reads honestly as one, else the canvas ----------
const sv = computed(() => stageView(wf.value))
// the describe card and a draft from it live on the canvas
const onCanvas = computed(() => route.query.view === 'canvas' || describeInline.value || !!aiDraft.value)
const view = computed(() => props.stagesFirst && !onCanvas.value && sv.value.fits ? 'stages' : 'canvas')
const fitNote = computed(() => props.stagesFirst && !onCanvas.value && !sv.value.fits ? sv.value.reason : null)
function setView(v: 'stages' | 'canvas') {
  router.replace({ query: { ...route.query, view: v === 'canvas' ? 'canvas' : undefined, stage: undefined } })
  if (v === 'canvas') leftTab.value = 'steps'
}

// ---------- stages: board columns, display only. The picked one lives in the URL (?stage=id) ----------
const leftTab = ref<'steps' | 'stages'>(route.query.stage ? 'stages' : 'steps')
const stages = computed(() => wf.value.stages ?? [])
const activeStage = computed(() => stages.value.find(s => s.id === route.query.stage) ?? null)
function setStage(id: string | null) {
  router.replace({ query: { ...route.query, stage: id ?? undefined, node: id ? undefined : route.query.node } })
  // bring the stage's steps into view; a stage spread over a long flow is otherwise half off-screen
  const keys = stages.value.find(s => s.id === id)?.nodeKeys ?? []
  if (keys.length) nextTick(() => fitView({ nodes: keys, padding: 0.3, minZoom: 0.85, maxZoom: 1, duration: ms(260) }))
}
function showTab(tab: 'steps' | 'stages') {
  leftTab.value = tab
  if (tab === 'steps') setStage(null)
  else select(null) // the stage list needs the full width
}
function addStage() {
  record()
  const id = `s_${Math.random().toString(36).slice(2, 8)}`
  wf.value.stages = [...stages.value, { id, name: `Stage ${stages.value.length + 1}`, nodeKeys: [] }]
  setStage(id)
}
function renameStage(id: string, name: string) {
  record()
  wf.value.stages!.find(s => s.id === id)!.name = name
}
function removeStage(id: string) {
  const st = stages.value.find(s => s.id === id)!
  record()
  wf.value.stages = stages.value.filter(s => s.id !== id)
  record()
  if (activeStage.value?.id === id) setStage(null)
  toast.show(`Deleted stage “${st.name}”. Its steps stay in the flow.`, { label: 'Undo', run: undo })
}
function moveStage(id: string, dir: -1 | 1) {
  record()
  const list = [...stages.value]
  const i = list.findIndex(s => s.id === id)
  list.splice(i + dir, 0, ...list.splice(i, 1))
  wf.value.stages = list
}
// The stage list adds a stage between two others; its name is selected there, ready to type over.
function addStageAt(at: number) {
  record()
  const list = [...stages.value]
  list.splice(at, 0, { id: `s_${Math.random().toString(36).slice(2, 8)}`, name: `Stage ${list.length + 1}`, nodeKeys: [] })
  wf.value.stages = list
}
// From the stage list: its steps join the stage before it (or after it, for the first), so none is left in no stage.
function mergeStage(id: string) {
  const list = stages.value
  const i = list.findIndex(s => s.id === id)
  const st = list[i]!
  const into = list[i - 1] ?? list[i + 1]
  if (!into) return removeStage(id)
  record()
  wf.value.stages = list.filter(s => s !== st).map(s => s === into ? { ...s, nodeKeys: [...s.nodeKeys, ...st.nodeKeys] } : s)
  record()
  toast.show(st.nodeKeys.length ? `Deleted stage “${st.name}”. Its steps joined “${into.name}”.` : `Deleted stage “${st.name}”`, { label: 'Undo', run: undo })
}
// A step added in the stage list goes after the stage's last step of its kind; with nothing to hang on to
// (an empty stage, a fork), in front of the first step it would come before.
// ponytail: a stage people enter in two places gets the step on one path only; the canvas handles that case.
function addInStage(stageId: string, kind: 'auto' | 'people', item: PaletteItem) {
  if (readOnly.value) return
  const g = wf.value
  const info = sv.value.stages.find(s => s.id === stageId)
  const i = sv.value.stages.findIndex(s => s.id === stageId)
  if (!info) return
  const node = makeNode(item, g, form.value)
  const outs = (k: string) => g.edges.filter(e => e.from === k).length
  const firstOf = (keys: string[]) => keys.find(k => !keys.some(o => o !== k && reaches(g, o, k)))
  const lastOf = (keys: string[]) => keys.find(k => !keys.some(o => o !== k && reaches(g, k, o)))
  const auto = info.auto.map(s => s.key)
  const people = info.people.map(s => s.key)
  const after = kind === 'auto' ? lastOf(auto) : lastOf(people) ?? lastOf(auto)
  let next: Graph | null = null
  if (after && outs(after) === 1) next = insertAfter(g, after, node)
  else {
    const later = sv.value.stages.slice(i + 1).map(s => [...s.auto, ...s.people].map(x => x.key)).find(k => k.length)
    const before = auto.length + people.length ? firstOf([...auto, ...people]) : later ? firstOf(later) : g.nodes.find(n => n.type === 'end' && (n.config as any)?.outcome === 'hired')?.key
    if (before) next = insertBefore(g, before, node, stageId)
  }
  if (!next) return toast.show('There’s no place for a step here yet. Add it on the canvas.')
  record()
  wf.value = next
  select(node.key)
}
// The stage list removes a step only when the flow closes up around it; otherwise it says why.
function removeInStages(key: string) {
  const n = wf.value.nodes.find(x => x.key === key)
  if (!n || readOnly.value) return
  const next = removeStep(wf.value, key)
  if (!next) return toast.show(removeBlocker(wf.value, key))
  record()
  wf.value = next
  record()
  select(null)
  toast.show(`Deleted “${titleOf(n)}”`, { label: 'Undo', run: undo })
}

// A step sits in one stage at most, so adding it here takes it out of any other.
function toggleInStage(key: string) {
  const st = activeStage.value
  const n = wf.value.nodes.find(x => x.key === key)
  if (!st || !n || readOnly.value) return
  if (!resting(n.type)) return toast.show(`Nobody waits at “${titleOf(n)}”, so the board has no row for it.`)
  record()
  const had = st.nodeKeys.includes(key)
  for (const s of wf.value.stages!) s.nodeKeys = s.nodeKeys.filter(k => k !== key)
  if (!had) st.nodeKeys.push(key)
}
// from the stage chip on a step's card: put it in this stage (out of any other), or in none
function assignStage(key: string, id: string | null) {
  record()
  for (const s of wf.value.stages!) s.nodeKeys = s.nodeKeys.filter(k => k !== key)
  if (id) wf.value.stages!.find(s => s.id === id)!.nodeKeys.push(key)
}
provide(STAGE_ACTIONS, { assign: assignStage, toggle: toggleInStage })
function dropFromStage(id: string, key: string) {
  record()
  const st = wf.value.stages!.find(s => s.id === id)!
  st.nodeKeys = st.nodeKeys.filter(k => k !== key)
}
function onNodeClick(key: string) {
  if (activeStage.value) toggleInStage(key)
  else select(key)
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
      stage: activeStage.value ? (activeStage.value.nodeKeys.includes(n.key) ? 'in' : resting(n.type) ? 'out' : 'na') : null,
      // on the Stages tab every step people wait at says its stage, and changes it, right on its card
      stageChip: leftTab.value !== 'stages' || readOnly.value || !stages.value.length || !resting(n.type)
        ? null
        : activeStage.value
          ? { mode: 'toggle', name: activeStage.value.name, in: activeStage.value.nodeKeys.includes(n.key), from: stages.value.find(st => st.id !== activeStage.value!.id && st.nodeKeys.includes(n.key))?.name ?? null }
          : { mode: 'pick', current: stages.value.find(st => st.nodeKeys.includes(n.key))?.id ?? null, options: stages.value.map(st => ({ id: st.id, name: st.name })) },
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
  const item = palette.value.flatMap(g => g.items).find(i => i.id === id)
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
  for (const st of wf.value.stages ?? []) st.nodeKeys = st.nodeKeys.map(k => (k === old ? next : k))
  select(next)
}

function removeNode(key: string) {
  const n = wf.value.nodes.find(x => x.key === key)
  if (!n || n.type === 'application_received' || readOnly.value) return
  record()
  wf.value.nodes = wf.value.nodes.filter(x => x.key !== key)
  wf.value.edges = wf.value.edges.filter(e => e.from !== key && e.to !== key)
  for (const st of wf.value.stages ?? []) st.nodeKeys = st.nodeKeys.filter(k => k !== key)
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
// the canvas sits hidden behind the stage list and measures nothing there; fit it once it shows
watch(view, v => v === 'canvas' && nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => fitOnLoad()))))
onNodesInitialized(async () => {
  if (loaded) return
  loaded = true
  if (activeStage.value?.nodeKeys.length) return fitView({ nodes: activeStage.value.nodeKeys, padding: 0.3, minZoom: 0.85, maxZoom: 1 })
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
  if (e.key === 'Escape' && activeStage.value) return setStage(null)
  if (e.key === 'Escape' && (selectedKey.value || selectedEdge.value)) return select(null)
  const onStep = (e.target as HTMLElement).closest?.('.vue-flow__node') as HTMLElement | null
  if (e.key === 'Enter' && onStep?.dataset.id) return e.preventDefault(), onNodeClick(onStep.dataset.id)
  const inCanvas = e.target === document.body || !!canvasEl.value?.contains(e.target as HTMLElement)
  if ((e.key === 'Delete' || e.key === 'Backspace') && inCanvas && view.value === 'canvas') {
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

// ---------- describe your flow: draft, then Save or Discard ----------
const describeDlg = ref<HTMLDialogElement>()
const presetsMenu = ref<InstanceType<typeof FlowPresetsMenu>>()
const drafting = ref<AbortController | null>(null)
const draftError = ref<string | null>(null)
const replacingNote = computed(() => aiDraft.value
  ? 'A new draft replaces this one. Your saved flow stays as it is until you save.'
  : 'The draft replaces the flow on the canvas until you save it. Discard brings this flow back.')
function openDescribe() {
  draftError.value = null
  describeDlg.value?.showModal()
}
function stopDrafting() {
  drafting.value?.abort()
  drafting.value = null
}
async function draftFlow() {
  if (drafting.value || !description.value.trim()) return
  const ctl = new AbortController()
  drafting.value = ctl
  draftError.value = null
  try {
    await flush() // a pending edit must reach the server before the draft takes the canvas
    const res = await api<{ workflow: Graph, issues: Issue[], summary: string }>('/api/flows/generate', {
      method: 'POST', body: { description: description.value.trim(), form: form.value }, signal: ctl.signal,
    })
    if (ctl.signal.aborted) return
    // a reply the server couldn't read at all comes back with no steps; never let it wipe the canvas
    if (!res.workflow.nodes.some(n => n.type === 'application_received')) {
      draftError.value = 'The draft didn’t come out right. Try again, or say it another way.'
      return
    }
    const pos = layout(res.workflow)
    const next: Graph = { ...res.workflow, nodes: res.workflow.nodes.map(n => ({ ...n, position: pos.get(n.key) ?? { x: 0, y: 0 } })) }
    aiDraft.value = { summary: res.summary, before: aiDraft.value?.before ?? clone(wf.value) }
    describeDlg.value?.close()
    select(null)
    resetHistory(next)
    nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      fitOnLoad()
      draftBar.value?.focus()
    })))
  }
  catch (e) {
    if (!ctl.signal.aborted) draftError.value = toApiError(e).message
  }
  finally {
    if (drafting.value === ctl) drafting.value = null
  }
}
// The draft is a fresh start: Undo works inside it, and Discard (not Undo) brings the old flow back.
function resetHistory(g: Graph) {
  undoStack.length = 0
  redoStack.length = 0
  canUndo.value = canRedo.value = false
  last = JSON.stringify(g)
  restoring = true
  wf.value = g
}
function discardDraft() {
  const d = aiDraft.value
  if (!d) return
  aiDraft.value = null
  quiet = true
  resetHistory(d.before)
  select(null)
  // the description is still in the box; an empty flow shows the card on the canvas by itself
  if (!isEmpty.value) nextTick(openDescribe)
  else nextTick(() => requestAnimationFrame(() => fitOnLoad()))
}
function saveDraftFlow() {
  if (!aiDraft.value) return
  aiDraft.value = null
  emit('edit')
  save()
}
onBeforeRouteLeave(() => !aiDraft.value || confirm('Leave without saving the draft? The steps from your description will be lost.'))
const draftBar = ref<HTMLElement>()
const draftCheck = computed(() => {
  const p = problemList.value[0]
  if (!p) return 'No problems found'
  const n = problemList.value.length
  // "Trial shift isn’t connected to a next step": the step's name starts the sentence issueText would start
  const what = p.node ? `${p.where} ${p.text.charAt(0).toLowerCase()}${p.text.slice(1)}` : p.text
  return `${n} thing${n === 1 ? '' : 's'} to check: ${what}`
})

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
  if (view.value === 'canvas') focusStep(key)
}
</script>

<template>
  <div ref="root" class="flow" :class="{ 'has-panel': !!selected, 'read-only': readOnly, editing, 'stages-view': view === 'stages' }" :style="{ height: `${height}px`, marginBottom: `${-pullUp}px` }">
    <nav v-if="!readOnly && view === 'canvas'" class="palette" :class="{ editing, 'on-stages': leftTab === 'stages' }" :aria-label="leftTab === 'steps' ? 'Add a step' : 'Stages'">
      <div class="seg left-tabs" role="radiogroup" aria-label="Show in this column">
        <label><input type="radio" name="left-tab" :checked="leftTab === 'steps'" @change="showTab('steps')"><span>Steps</span></label>
        <label><input type="radio" name="left-tab" :checked="leftTab === 'stages'" @change="showTab('stages')"><span>Stages <b v-if="stages.length" class="tab-n">{{ stages.length }}</b></span></label>
      </div>
      <StagesPanel
        v-if="leftTab === 'stages'" :stages="stages" :active="activeStage?.id ?? null" :nodes="wf.nodes"
        @add="addStage" @activate="setStage" @rename="renameStage" @remove="removeStage" @move="moveStage" @drop="dropFromStage"
      />
      <template v-else>
      <div class="pal-top">
        <p class="pal-hint">{{ editing ? 'Hide, reorder or add. Changes reach every job’s palette.' : 'Click to add under the selected step, or drag onto the canvas.' }}</p>
        <button type="button" class="btn btn-sm" :class="editing ? 'btn-dark' : 'btn-quiet'" :aria-pressed="editing" @click="toggleEditing">
          <Icon :name="editing ? 'check' : 'edit'" />{{ editing ? 'Done' : 'Edit' }}
        </button>
      </div>
      <p v-if="presetsError && !presets" class="pal-hint pal-err">Presets didn’t load. <button type="button" class="linkish" @click="refreshPresets">Try again</button></p>
      <section v-for="g in palette" :key="g.key">
        <h3 class="eyebrow">{{ g.group }}</h3>
        <template v-for="item in g.items" :key="item.id">
          <div v-if="editing" class="pal-row" :class="{ blank: !item.presetId }" :data-preset="item.presetId">
            <Icon :name="item.icon" :size="16" /><span class="pal-label">{{ item.label }}</span>
            <template v-if="item.presetId">
              <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Move ${item.label} up`" data-dir="-1" :disabled="isFirstShown(g.key, item)" @click="movePreset(g.key, item, -1)"><Icon name="arrow-up" :size="14" /></button>
              <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Move ${item.label} down`" data-dir="1" :disabled="isLastShown(g.key, item)" @click="movePreset(g.key, item, 1)"><Icon name="arrow-down" :size="14" /></button>
              <button type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Hide ${item.label} from the palette`" title="Hide from the palette" @click="setShown({ id: item.presetId, label: item.label }, false)"><Icon name="eye-off" :size="14" /></button>
            </template>
            <span v-else class="always" title="Blank steps are always in the palette">Blank</span>
          </div>
          <button
            v-else type="button" class="pal-item" draggable="true" :title="item.label"
            @click="addStep(item)" @dragstart="onDragStart($event, item)"
          >
            <Icon :name="item.icon" :size="16" /><span class="pal-label">{{ item.label }}</span>
          </button>
        </template>
        <div v-if="editing" class="pal-add">
          <button type="button" class="btn btn-sm btn-quiet" :popovertarget="`pal-add-${g.key}`" :style="{ anchorName: `--pal-add-${g.key}` }">
            <Icon name="plus" />{{ hiddenIn(g.key).length ? `Show hidden (${hiddenIn(g.key).length})` : 'New preset…' }}
          </button>
          <div :id="`pal-add-${g.key}`" popover class="menu pal-menu" :style="{ positionAnchor: `--pal-add-${g.key}` }">
            <button v-for="p in hiddenIn(g.key)" :key="p.id" type="button" @click="setShown(p, true)"><Icon :name="nodeMeta(p.type).icon" :size="16" />{{ p.label }}</button>
            <template v-if="hiddenIn(g.key).length"><hr></template>
            <p v-else class="menu-note">Every {{ g.group.toLowerCase() }} preset is already in the palette. Make a new one in the step library:</p>
            <NuxtLink v-for="t in [...new Set(g.items.map(i => i.type))]" :key="t" :to="{ path: '/library', query: { new: t } }">
              <Icon name="plus" :size="16" />New {{ blankNoun(t) }} preset
            </NuxtLink>
          </div>
        </div>
      </section>
      </template>
    </nav>

    <StageList
      v-if="view === 'stages'" class="stage-main" :graph="wf" :view="sv" :form="form" :issues-by="issuesBy" :roles="roles" :people="people"
      :selected-key="selectedKey" :read-only="readOnly" :form-href="source.formHref" :palette="palette"
      @select="select" @add="addInStage" @remove="removeInStages" @rename="renameStage" @move="moveStage" @remove-stage="mergeStage"
      @add-stage="addStageAt" @canvas="setView('canvas')"
    >
      <template #status>
        <div class="panel box status" role="group" aria-label="Draft">
          <div class="status-row">
            <span v-if="readOnly" class="locked" role="status"><Icon name="lock" :size="14" />Archived: read-only</span>
            <button v-else-if="issues.length" type="button" class="btn btn-sm problems-btn" popovertarget="flow-problems">
              <Icon name="alert" />{{ issues.length }} problem{{ issues.length === 1 ? '' : 's' }}
            </button>
            <span v-else class="ready"><Icon name="check" :size="14" />Ready to publish</span>
            <template v-if="!readOnly">
              <button type="button" class="btn btn-quiet btn-icon btn-sm push" :disabled="!canUndo" aria-label="Undo" title="Undo (⌘Z)" @click="undo"><Icon name="reopen" /></button>
              <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="!canRedo" aria-label="Redo" title="Redo (⇧⌘Z)" @click="redo"><Icon name="reopen" class="flip" /></button>
            </template>
          </div>
          <span v-if="!readOnly" class="save" aria-live="polite">
            <template v-if="saveState === 'saving'"><span class="spinner" />Saving…</template>
            <template v-else-if="saveState === 'saved'">Saved to the draft. Publish to use it for new applicants.</template>
            <template v-else-if="saveState === 'error'">
              <span class="save-err">Not saved: {{ saveError }}</span>
              <button type="button" class="btn btn-sm" @click="save">Retry</button>
            </template>
            <template v-else>Changes save as you go.</template>
          </span>
        </div>
      </template>
    </StageList>

    <div v-show="view === 'canvas'" ref="canvasEl" class="canvas" :class="{ staging: !!activeStage }" @dragover.prevent @drop.prevent="onDrop">
      <VueFlow
        :nodes="vfNodes" :edges="vfEdges" :min-zoom="0.2" :max-zoom="1.6"
        :nodes-draggable="!readOnly" :nodes-connectable="!readOnly" :elements-selectable="false"
        :connection-mode="ConnectionMode.Strict" :is-valid-connection="isValidConnection"
        :delete-key-code="null" :snap-to-grid="true" :snap-grid="[GRID, GRID]"
        :connection-line-options="{ type: 'smoothstep' as any }"
        @connect="onConnect" @node-click="({ node }) => onNodeClick(node.id)" @pane-click="activeStage ? setStage(null) : select(null)"
        @edge-click="({ edge }) => { select(null); selectedEdge = edge.id }"
        @node-drag-stop="onDragStop"
      >
        <template #node-step="p">
          <StepNode v-bind="p" />
        </template>
        <!-- dots on the snap grid: steps snap to them, and they show the canvas moving when you pan -->
        <Background variant="dots" :gap="GRID" :size="1.2" color="oklch(0.89 0.008 330)" />
      </VueFlow>

      <!-- a draft from a description: unsaved until Save flow (mock frame 5) -->
      <div v-if="aiDraft" ref="draftBar" class="draft-bar" role="region" aria-label="Unsaved draft" tabindex="-1">
        <p :title="`${aiDraft.summary} · ${draftCheck}`">Draft from your description <span class="dim">· {{ aiDraft.summary }} · {{ draftCheck }}</span></p>
        <button type="button" class="btn btn-sm btn-quiet" @click="discardDraft">Discard</button>
        <button type="button" class="btn btn-sm btn-primary" @click="saveDraftFlow">Save flow</button>
      </div>
      <section v-if="aiDraft" class="card your-words" aria-labelledby="your-words-h">
        <h3 id="your-words-h" class="eyebrow">Your description</h3>
        <p>“{{ description.trim() }}”</p>
        <button type="button" class="btn btn-sm" @click="openDescribe">Edit and redraft</button>
      </section>

      <div class="toolbar" :class="{ 'under-bar': aiDraft }" role="toolbar" aria-label="Canvas">
        <template v-if="stagesFirst && sv.fits">
          <button type="button" class="btn btn-quiet btn-sm" @click="setView('stages')"><Icon name="arrow-left" />Stage list</button>
          <span class="sep" />
        </template>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Zoom out" title="Zoom out" @click="zoomOut({ duration: ms(160) })"><Icon name="zoom-out" /></button>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Zoom in" title="Zoom in" @click="zoomIn({ duration: ms(160) })"><Icon name="zoom-in" /></button>
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Fit the whole flow" title="Fit the whole flow" @click="fitView({ padding: 0.12, duration: ms(260) })"><Icon name="fit" /></button>
        <template v-if="!readOnly">
          <span class="sep" />
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="!canUndo" aria-label="Undo" title="Undo (⌘Z)" @click="undo"><Icon name="reopen" /></button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" :disabled="!canRedo" aria-label="Redo" title="Redo (⇧⌘Z)" @click="redo"><Icon name="reopen" class="flip" /></button>
        </template>
        <span class="sep" />
        <template v-if="aiOn && !readOnly && !isEmpty && !aiDraft">
          <button type="button" class="btn btn-quiet btn-sm" @click="openDescribe"><Icon name="edit" />Draft from a description</button>
          <span class="sep" />
        </template>
        <template v-if="isJob && !aiDraft">
          <FlowPresetsMenu ref="presetsMenu" :source="presetSource" :form="form" :workflow="wf" :live-version="source.lockVersion.value" :save-only="readOnly" @replace="(next, name) => emit('replace', next, name)" />
          <span class="sep" />
        </template>
        <span v-if="readOnly" class="locked" role="status"><Icon name="lock" :size="14" />Archived: read-only</span>
        <button v-else-if="issues.length" type="button" class="btn btn-sm problems-btn" popovertarget="flow-problems">
          <Icon name="alert" />{{ issues.length }} problem{{ issues.length === 1 ? '' : 's' }}
        </button>
        <span v-else class="ready"><Icon name="check" :size="14" />{{ isJob ? 'Ready to publish' : 'No problems' }}</span>
        <span v-if="!readOnly && !aiDraft" class="save" aria-live="polite">
          <template v-if="saveState === 'saving'"><span class="spinner" />Saving…</template>
          <template v-else-if="saveState === 'saved'">Saved</template>
          <template v-else-if="saveState === 'error'">
            <span class="save-err">Not saved: {{ saveError }}</span>
            <button type="button" class="btn btn-sm" @click="save">Retry</button>
          </template>
        </span>
      </div>

      <div v-if="describeInline" class="describe-wrap">
        <DescribeFlow
          v-model="description" class="card" data-slot="ink" mode="inline" :is-job="isJob" :busy="!!drafting" :error="draftError" :replacing="null"
          :can-preset="isJob" @draft="draftFlow" @stop="stopDrafting" @preset="presetsMenu?.openLoad()" @close="startedEmpty = true"
        />
      </div>

      <p v-if="fitNote" class="fit-note" role="note">
        <Icon name="split" :size="16" />
        <span><b>Shown as a diagram.</b> {{ fitNote }} The stage list needs each step people wait at in one stage, with people only moving forward.</span>
      </p>
    </div>

    <dialog ref="describeDlg" class="dialog describe-dlg" aria-label="Draft from a description" @close="stopDrafting" @click.self="describeDlg?.close()">
      <DescribeFlow
        v-model="description" mode="dialog" :is-job="isJob" :busy="!!drafting" :error="draftError" :replacing="replacingNote"
        :can-preset="false" @draft="draftFlow" @stop="stopDrafting" @close="describeDlg?.close()"
      />
    </dialog>

    <div id="flow-problems" ref="problemsMenu" popover class="menu problems-menu">
      <div class="pm-head eyebrow">{{ isJob ? 'Fix these before you publish' : 'A job that starts from this fixes these before it can publish' }}</div>
      <button v-for="(p, i) in problemList" :key="i" type="button" :disabled="!p.node" @click="goTo(p.node)">
        <span class="pm-where">{{ p.where }}</span>
        <span class="pm-text">{{ p.text }}</span>
      </button>
    </div>

    <StepPanel
      v-if="selected" :key="selected.key" class="side" :node="selected" :graph="wf" :form="form" :roles="roles" :people="people"
      :issues="issuesBy.get(selected.key) ?? []" :key-locked="source.lockedKeys.value.has(selected.key)" :read-only="readOnly"
      :form-href="source.formHref" :job="source.sample.value"
      @rename="renameNode" @connect="(b, to) => connect(selected!.key, to, b)" @remove="view === 'stages' ? removeInStages(selected!.key) : removeNode(selected!.key)" @close="select(null)"
      @save-preset="saveAsPreset(selected!.key)"
    />
  </div>
</template>

<style scoped>
.flow {
  display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 560px; min-width: 0;
  border-top: 1px solid var(--line); background: var(--surface);
}
.flow.has-panel { grid-template-columns: 260px minmax(0, 1fr) 380px; }
/* edit mode needs room for the move and hide buttons beside each name */
.flow.read-only { grid-template-columns: minmax(0, 1fr); }
.flow.read-only.has-panel { grid-template-columns: minmax(0, 1fr) 380px; }
.flow.stages-view, .flow.stages-view.read-only { grid-template-columns: minmax(0, 1fr); }
.flow.stages-view.has-panel, .flow.stages-view.has-panel:not(.read-only) { grid-template-columns: minmax(0, 1fr) 380px; }
.stage-main { min-height: 0; }
.status { display: grid; gap: 8px; padding: 16px 18px; border-radius: var(--r-card); }
.status-row { display: flex; align-items: center; gap: 2px; }
.status .ready, .status .locked { padding-left: 0; }
.status .save { padding: 0; }
.push { margin-left: auto; }
.fit-note {
  position: absolute; z-index: 5; left: 14px; bottom: 14px; display: flex; gap: 10px; max-width: min(560px, calc(100% - 28px));
  padding: 12px 14px; border-radius: var(--r-panel); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-2);
  font-size: var(--t-sm); color: var(--ink-2);
}
.fit-note svg { flex: none; margin-top: 2px; color: var(--ink-3); }
.fit-note b { color: var(--ink); }

.left-tabs { display: flex; }
.left-tabs label { flex: 1; }
.left-tabs span { justify-content: center; }
.tab-n { font-weight: 600; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.palette { overflow-y: auto; padding: 14px 12px 24px; border-right: 1px solid var(--line); background: var(--surface); display: grid; align-content: start; gap: 16px; }
.pal-hint { font-size: var(--t-xs); color: var(--ink-2); padding: 0 6px; }
.palette section { display: grid; gap: 2px; }
.palette h3 { padding: 0 8px 4px; }
.pal-item {
  position: relative; display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 6px 8px 6px 10px; border: 0; border-radius: 10px;
  background: none; text-align: left; font-weight: 500; color: var(--ink); cursor: grab;
}
.pal-item:hover { background: var(--hover); }
.pal-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.pal-top .pal-hint { padding-top: 6px; }
.pal-top .btn { flex: none; }
.pal-err { color: var(--bad); }
.linkish { border: 0; background: none; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
.pal-row { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 2px 2px 2px 10px; border-radius: 10px; background: var(--sunk); }
.pal-row + .pal-row { margin-top: 2px; }
.pal-row .pal-label { flex: 1; min-width: 0; }
.pal-row svg { flex: none; color: var(--ink-2); }
.pal-row.blank { background: none; }
.always { font-size: var(--t-xs); font-weight: 600; color: var(--ink-3); padding-right: 10px; }
.pal-add { padding-top: 4px; }
.pal-menu { inset: auto; top: anchor(bottom); left: anchor(left); margin-top: 4px; max-width: 300px; }
.menu-note { padding: 8px 10px; font-size: var(--t-sm); color: var(--ink-2); }
.pal-item:active { cursor: grabbing; }
.pal-item svg { flex: none; color: var(--ink-2); }
/* the badge slot, turned sideways: who acts in this kind of step */

/* narrow screens with a step open: the palette folds to icons so the canvas keeps room */
@media (width < 1360px) {
  .flow.has-panel:not(.read-only) { grid-template-columns: 60px minmax(0, 1fr) 350px; }
  .has-panel .left-tabs { display: none; }
  .has-panel .palette { padding: 12px 8px; gap: 10px; }
  .has-panel .pal-hint, .has-panel .pal-label, .has-panel .palette h3 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .has-panel .palette section + section { border-top: 1px solid var(--line); padding-top: 10px; }
  .has-panel .pal-item { justify-content: center; padding: 8px; }
}

.canvas { position: relative; min-width: 0; min-height: 0; background: var(--bg); }

/* describe your flow: the card sits over the empty canvas; the start step stays drawn behind it */
.describe-wrap { position: absolute; z-index: 6; inset: 0; display: grid; place-items: center; padding: 72px 24px 24px; overflow-y: auto; pointer-events: none; }
.describe-wrap > * { pointer-events: auto; }
.describe-dlg { width: min(560px, calc(100vw - 32px)); }
/* ink, like the system's own slot colour: this draft is the system's work until a person saves it */
.draft-bar {
  position: absolute; z-index: 7; top: 14px; left: 14px; right: 14px; display: flex; align-items: center; gap: 8px;
  padding: 6px 6px 6px 18px; border-radius: var(--r-pill); background: var(--ink); color: #fff; box-shadow: var(--shadow-3);
}
.draft-bar:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.draft-bar p { flex: 1; min-width: 0; font-weight: 600; font-size: var(--t-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.draft-bar .dim { font-weight: 500; color: oklch(1 0 0 / 0.72); }
.draft-bar .btn-quiet { color: oklch(1 0 0 / 0.85); }
@media (hover: hover) { .draft-bar .btn-quiet:hover { --b-bg: oklch(1 0 0 / 0.12); color: #fff; } }
.toolbar.under-bar { top: 66px; }
.your-words {
  position: absolute; z-index: 5; left: 14px; bottom: 14px; display: grid; justify-items: start; gap: 8px;
  width: min(300px, calc(100% - 28px)); padding: 14px; border-radius: var(--r-panel); font-size: var(--t-sm);
}
.your-words p { color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
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
