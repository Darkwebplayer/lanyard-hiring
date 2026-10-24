<script setup lang="ts">
import { PRESET_SECTIONS } from '~~/shared/workflow/presets'
import { REGISTRY } from '~~/shared/workflow/registry'
import { STANDARD_HIRE } from '~~/shared/workflow/templates'
import type { Graph, GraphNode, Issue } from '~~/shared/workflow/types'
import StepPanel from '~/components/flow/StepPanel.vue'
import { SAMPLE_JOB } from '~/composables/useFlowSource'
import { type Person, type Preset, type Role, blankConfig, blankItem, blankNoun, summaryOf } from '~/lib/flow'

useHead({ title: 'Steps · Library' })
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { presets, error, refresh, create, update, remove } = usePresets()
refresh()

const roles = ref<Role[]>([])
const people = ref<Person[] | null>(null)
api<Role[]>('/api/roles').then(r => (roles.value = r)).catch(() => {})
api<Person[]>('/api/users/assignable').then(r => (people.value = r)).catch(() => {})

const sections = computed(() => PRESET_SECTIONS.map(s => ({
  ...s,
  presets: (presets.value ?? []).filter(p => (s.types as readonly string[]).includes(p.type)).sort((a, b) => a.position - b.position),
})))

// ---------- the editor: one preset (?preset=id) or a new one (?new=type) ----------
const selectedId = computed(() => route.query.preset as string | undefined)
const newType = computed(() => {
  const t = route.query.new as string | undefined
  return t && REGISTRY[t] && PRESET_SECTIONS.some(s => (s.types as readonly string[]).includes(t)) ? t : undefined
})
const selected = computed(() => presets.value?.find(p => p.id === selectedId.value))

// Presets are edited as a step placed after Standard hire's Read CV and AI review, so the field pickers
// offer the usual answers (AI review · Overall). A flow with other keys flags any mismatch at publish.
function sampleGraph(node: GraphNode): Graph {
  const base = STANDARD_HIRE.workflow.nodes.filter(n => ['start', 'cv', 'ai'].includes(n.key))
  return { nodes: [...structuredClone(base), node], edges: [{ from: 'start', to: 'cv' }, { from: 'cv', to: 'ai' }, { from: 'ai', to: node.key }] }
}
const serverIssues = ref<Issue[]>([])
const draft = ref<{ node: GraphNode, description: string, graph: Graph } | null>(null)
const pristine = ref('')
const snapshot = () => (draft.value ? JSON.stringify([draft.value.node.label, draft.value.node.config, draft.value.description]) : '')
const dirty = computed(() => !!draft.value && snapshot() !== pristine.value)

function openDraft() {
  serverIssues.value = []
  if (selected.value) {
    const p = selected.value
    const node: GraphNode = { key: 'preset', type: p.type, label: p.label, config: structuredClone(toRaw(p.config)) }
    draft.value = { node, description: p.description, graph: sampleGraph(node) }
  }
  else if (newType.value) {
    const node: GraphNode = { key: 'preset', type: newType.value, label: `New ${blankNoun(newType.value)}`, config: null }
    const graph = sampleGraph(node)
    node.config = blankConfig(newType.value, graph, STANDARD_HIRE.form)
    draft.value = { node: graph.nodes.at(-1)!, description: '', graph }
  }
  else draft.value = null
  pristine.value = snapshot()
}
watch([selectedId, newType, () => !!presets.value], openDraft, { immediate: true })

const shapeIssues = computed<Issue[]>(() => {
  const n = draft.value?.node
  if (!n) return []
  const r = REGISTRY[n.type]!.config.safeParse(n.config)
  return r.success ? [] : r.error.issues.map(i => ({ node: 'preset', code: 'invalid_config', message: `${i.path.join('.') || 'settings'}: ${i.message}` }))
})
const issues = computed(() => [...shapeIssues.value, ...serverIssues.value])

const saving = ref(false)
async function save() {
  const d = draft.value
  if (!d || saving.value) return
  const label = (d.node.label ?? '').trim()
  if (!label) return toast.show('Give the preset a name first.')
  if (shapeIssues.value.length) return
  saving.value = true
  serverIssues.value = []
  try {
    if (selected.value) {
      await update(selected.value.id, { label, description: d.description.trim(), config: d.node.config })
      pristine.value = snapshot()
      toast.show(`Saved “${label}”. New steps start from it; steps already in flows keep theirs.`)
    }
    else {
      const p = await create({ type: d.node.type, label, description: d.description.trim(), config: d.node.config })
      pristine.value = snapshot()
      await router.replace({ query: { preset: p.id } })
      toast.show(`Added “${label}” to the palette`)
    }
  }
  catch (e) {
    const err = e as ApiError
    if (err.issues.length) serverIssues.value = err.issues.map(i => ({ ...i, node: 'preset' }))
    else toast.show(err.message)
  }
  finally { saving.value = false }
}

function choose(query: Record<string, string>) {
  if (dirty.value && !confirm('Discard the unsaved changes to this preset?')) return
  pristine.value = snapshot() // so the route guard doesn't ask twice
  router.replace({ query })
}
onBeforeRouteLeave(() => !dirty.value || confirm('Discard the unsaved changes to this preset?'))

async function toggleShown(p: Preset) {
  try { await update(p.id, { inPalette: !p.inPalette }) }
  catch (e) { toast.show((e as ApiError).message) }
}

// ---------- delete ----------
const dlg = ref<HTMLDialogElement>()
const deleting = ref(false)
async function confirmDelete() {
  const p = selected.value
  if (!p) return
  deleting.value = true
  try {
    await remove(p.id)
    dlg.value?.close()
    pristine.value = snapshot()
    await router.replace({ query: {} })
    toast.show(`Deleted “${p.label}”`)
  }
  catch (e) { toast.show((e as ApiError).message) }
  finally { deleting.value = false }
}
</script>

<template>
  <div class="lib">
    <p class="lede">The steps every job’s flow can start from. The palette on the canvas shows the ones marked “In palette”, in this order; reorder them from the palette’s Edit.</p>

    <div v-if="error && !presets" class="empty" role="alert">
      <h2>The step library didn’t load</h2>
      <p>{{ error.message }}</p>
      <button class="btn" @click="refresh">Try again</button>
    </div>

    <div v-else class="cols">
      <div class="list">
        <template v-if="!presets">
          <div v-for="i in 4" :key="i" class="panel sk"><span class="skeleton" style="height: 14px; width: 30%" /><span class="skeleton" style="height: 40px" /><span class="skeleton" style="height: 40px" /></div>
        </template>
        <section v-for="s in sections" v-else :key="s.key" class="panel sect" :aria-labelledby="`sec-${s.key}`">
          <header class="sect-head">
            <h2 :id="`sec-${s.key}`">{{ s.label }} <span class="faint">{{ s.presets.length }}</span></h2>
            <button v-if="s.types.length === 1" type="button" class="btn btn-sm btn-quiet" @click="choose({ new: s.types[0] })"><Icon name="plus" />New preset</button>
            <template v-else>
              <button type="button" class="btn btn-sm btn-quiet" :popovertarget="`new-${s.key}`" :style="{ anchorName: `--new-${s.key}` }"><Icon name="plus" />New preset<Icon name="chevron-down" :size="14" /></button>
              <div :id="`new-${s.key}`" popover class="menu new-menu" :style="{ positionAnchor: `--new-${s.key}` }">
                <button v-for="t in s.types" :key="t" type="button" @click="($event.currentTarget as HTMLElement).closest<HTMLElement>('[popover]')?.hidePopover(); choose({ new: t })">
                  <Icon :name="nodeMeta(t).icon" :size="16" />{{ blankItem(t).label }}
                </button>
              </div>
            </template>
          </header>
          <ul v-if="s.presets.length" class="rows">
            <li v-for="p in s.presets" :key="p.id" class="row" :class="{ current: p.id === selectedId, off: !p.inPalette }">
              <button type="button" class="pick" :aria-current="p.id === selectedId ? 'true' : undefined" @click="choose({ preset: p.id })">
                <span class="ico"><Icon :name="nodeMeta(p.type).icon" :size="16" /></span>
                <span class="text">
                  <b>{{ p.label }}</b>
                  <span class="muted">{{ p.description || summaryOf({ key: 'preset', type: p.type, config: p.config }, STANDARD_HIRE.form, roles) }}</span>
                </span>
              </button>
              <label class="show" :title="p.inPalette ? 'Shown in the palette' : 'Hidden from the palette'">
                <input type="checkbox" role="switch" :checked="p.inPalette" :aria-label="`${p.label} in the palette`" @change="toggleShown(p)">
                <span>{{ p.inPalette ? 'In palette' : 'Hidden' }}</span>
              </label>
            </li>
          </ul>
          <p v-else class="none">No presets yet.</p>
          <p class="blanks"><span>Always in the palette too, as blank steps:</span> {{ s.types.map(t => blankItem(t).label).join(', ') }}</p>
        </section>
      </div>

      <div class="detail">
        <div v-if="draft" class="editor card">
          <StepPanel
            :key="`${selectedId ?? 'new'}-${draft.node.type}`" :node="draft.node" :graph="draft.graph" :form="STANDARD_HIRE.form"
            :roles="roles" :people="people" :issues="issues" :key-locked="false" :read-only="false" form-href="" :job="SAMPLE_JOB" preset
            @close="choose({})"
          >
            <template #extra>
              <div class="field">
                <label for="p-desc">Description</label>
                <input id="p-desc" v-model="draft.description" maxlength="300" placeholder="When to use it, in a line">
                <p class="hint">Shown under the name in this library.</p>
              </div>
            </template>
          </StepPanel>
          <footer class="foot">
            <button v-if="selected" type="button" class="btn btn-danger btn-sm" @click="dlg?.showModal()"><Icon name="trash" />Delete</button>
            <span class="status" aria-live="polite">{{ dirty ? (selected ? 'Unsaved. Saving changes new steps in every job; flows keep their copy.' : 'New presets go into every job’s palette.') : selected ? 'Saved' : '' }}</span>
            <button type="button" class="btn btn-primary" :disabled="saving || (!dirty && !!selected) || shapeIssues.length > 0" :aria-busy="saving" @click="save">
              <span v-if="saving" class="spinner" />{{ selected ? 'Save preset' : 'Add preset' }}
            </button>
          </footer>
        </div>
        <div v-else-if="presets" class="pick-hint">
          <p>Choose a preset to edit it, or add a new one to a section.</p>
          <p class="faint">Changing a preset never changes flows that already use it: each step keeps its own copy.</p>
        </div>
      </div>
    </div>

    <dialog ref="dlg" class="dialog" closedby="any" aria-labelledby="del-h">
      <div class="dialog-body">
        <h2 id="del-h">Delete “{{ selected?.label }}”?</h2>
        <p class="muted">It leaves the library and every palette. Steps already in flows keep their settings. You can’t undo this.</p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="dlg?.close()">Keep it</button>
        <button type="button" class="btn btn-danger" :disabled="deleting" :aria-busy="deleting" @click="confirmDelete">Delete preset</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.lede { color: var(--ink-2); margin-bottom: 20px; max-width: 75ch; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(380px, 460px); gap: 24px; align-items: start; }
.list { display: grid; gap: 16px; min-width: 0; }
.sk { display: grid; gap: 10px; padding: 16px; }
.sect { padding: 6px 6px 8px; }
.sect-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 10px 8px 12px; }
.sect-head h2 { font-size: var(--t-lg); }
.new-menu { inset: auto; top: anchor(bottom); right: anchor(right); margin-top: 4px; }
.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.row { display: flex; align-items: center; gap: 8px; border-radius: 12px; padding-right: 10px; transition: background var(--t-micro) var(--ease); }
.row:hover { background: var(--hover); }
.row.current { background: var(--accent-tint); }
.pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 12px; color: var(--ink); }
.ico { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 10px; background: var(--sunk); color: var(--ink-2); }
.row.current .ico { background: var(--surface); color: var(--accent-ink); }
.text { display: grid; min-width: 0; }
.text b { font-weight: 600; overflow-wrap: anywhere; }
.text .muted { font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.off .text b { color: var(--ink-2); font-weight: 500; }
.none { padding: 6px 12px 4px; font-size: var(--t-sm); color: var(--ink-2); }
.blanks { padding: 8px 12px 6px; font-size: var(--t-sm); color: var(--ink-3); }
.blanks span { color: var(--ink-2); }
.foot .status { text-wrap: pretty; }

/* switch: applies at once, like Team's */
.show { display: inline-flex; align-items: center; gap: 8px; flex: none; font-size: var(--t-sm); color: var(--ink-2); cursor: pointer; white-space: nowrap; min-width: 108px; }
/* a transparent 2px border grows the target to 38 × 24 (the 24 px minimum) while the track still draws 34 × 20 */
.show input { width: 38px; height: 24px; border-radius: 99px; border: 2px solid transparent; background: var(--line-2) padding-box; position: relative; }
.show input::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; scale: 1; clip-path: none; box-shadow: 0 1px 2px oklch(0.3 0.04 330 / 0.3); transition: translate var(--t-micro) var(--ease); }
.show input:checked { background: var(--ink) padding-box; border-color: transparent; }
.show input:checked::before { translate: 14px 0; }

.detail { position: sticky; top: 24px; min-width: 0; }
/* sized from where the panel starts under the page header, so Save is on screen the moment it opens */
.editor { display: grid; overflow: hidden; max-height: calc(100dvh - 132px); grid-template-rows: minmax(0, 1fr) auto; }
.editor :deep(.panel-side) { overflow-y: auto; border: 0; }
.foot { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface); }
.foot .status { margin-left: auto; font-size: var(--t-sm); color: var(--ink-2); }
.pick-hint { display: grid; gap: 8px; padding: 28px 24px; border: 1.5px dashed var(--line-2); border-radius: var(--r-card); color: var(--ink-2); }
@media (max-height: 600px) { .detail { position: static; } }
</style>
