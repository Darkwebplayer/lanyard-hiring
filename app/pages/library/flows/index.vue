<script setup lang="ts">
import { jobFieldsRead, namedPeople } from '~~/shared/workflow/flowPresets'
import { validateVersion } from '~~/shared/workflow/graph'
import { STANDARD_HIRE } from '~~/shared/workflow/templates'
import type { FormField, Graph } from '~~/shared/workflow/types'
import { type Person, issueText } from '~/lib/flow'

useHead({ title: 'Flows · Library' })
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { flowPresets, error, refresh, create, update, remove } = useFlowPresets()
refresh()

const people = ref<Person[] | null>(null)
api<Person[]>('/api/users/assignable').then(r => (people.value = r)).catch(() => {})

interface Row { id: string, name: string, description: string, form: FormField[], workflow: Graph, builtIn: boolean }
const STANDARD: Row = { id: 'standard', name: 'Standard hire', description: 'CV read, AI review, shortlist, interview, offer.', ...STANDARD_HIRE, builtIn: true }
const rows = computed<Row[]>(() => [STANDARD, ...(flowPresets.value ?? []).map(p => ({ ...p, builtIn: false }))])

const steps = (g: Graph) => g.nodes.filter(n => n.type !== 'application_received').length
const counts = (r: Row) => `${plural(steps(r.workflow), 'step')} · ${plural(r.form.length, 'field')}`

// ---------- the detail: ?flow=<id|standard> ----------
// your first saved preset until something else is chosen (its Rename, Duplicate and Delete are right there),
// else Standard hire: there is always a flow to look at
const selectedId = computed(() => (route.query.flow as string | undefined) ?? flowPresets.value?.[0]?.id ?? 'standard')
const selected = computed(() => rows.value.find(r => r.id === selectedId.value))
// a link to a preset someone deleted (only knowable once the list is in)
const gone = computed(() => !!flowPresets.value && !selected.value)

// Steps in the order a candidate meets them: along the edges from the start; anything unconnected last.
function ordered(g: Graph) {
  const start = g.nodes.find(n => n.type === 'application_received')
  const seen = new Set<string>(start ? [start.key] : [])
  const queue = start ? [start.key] : []
  while (queue.length) {
    for (const e of g.edges.filter(e => e.from === queue[0])) if (!seen.has(e.to)) (seen.add(e.to), queue.push(e.to))
    queue.shift()
  }
  const keys = [...seen, ...g.nodes.map(n => n.key).filter(k => !seen.has(k))]
  return keys.map(k => g.nodes.find(n => n.key === k)!).filter(n => n && n.type !== 'application_received')
}

const facts = computed(() => {
  const r = selected.value
  if (!r) return null
  const names = new Map((people.value ?? []).map(p => [p.id, p.name]))
  return {
    steps: ordered(r.workflow),
    fields: r.form.map(f => (f as { label?: string }).label || f.key),
    reads: jobFieldsRead(r.workflow).map(f => f.label),
    named: namedPeople(r.workflow).map(n => ({
      key: n.key,
      step: nodeLabel(n),
      // people who left, or can't sign in, aren't in the assignable list
      people: ((n.config as { assignees: { users: string[] } }).assignees.users).map(id => ({ id, name: names.get(id), gone: !!people.value && !names.has(id) })),
    })),
    // named, like the canvas names them, so nobody has to start a job to learn what's wrong
    problems: validateVersion(r.form, r.workflow).map((i) => {
      const n = r.workflow.nodes.find(x => x.key === i.node)
      return { where: n ? nodeLabel(n) : i.node ? i.node : 'The flow', node: n?.key, text: issueText(i, r.workflow).replace(/\.$/, '') }
    }),
  }
})

// ---------- duplicate: a copy to change, opened at once ----------
const duplicating = ref(false)
async function duplicate() {
  const r = selected.value
  if (!r || duplicating.value) return
  duplicating.value = true
  try {
    const copy = await create({ name: `${r.name} (copy)`.slice(0, 100), description: r.description, form: structuredClone(toRaw(r.form)), workflow: structuredClone(toRaw(r.workflow)) })
    await router.replace({ query: { flow: copy.id } })
    toast.show(`Made “${copy.name}”. Rename it to tell them apart.`)
  }
  catch (e) { toast.show((e as ApiError).message) }
  finally { duplicating.value = false }
}

// ---------- new: an empty flow, opened in its editor (which offers to draft it from a description) ----------
const making = ref(false)
async function newFlow() {
  if (making.value) return
  making.value = true
  try {
    const p = await create({
      name: 'New flow', description: '', form: [],
      // the same start a blank job gets
      workflow: { nodes: [{ key: 'start', type: 'application_received', config: {}, position: { x: 0, y: 0 } }], edges: [], stages: [{ id: 'screening', name: 'Screening', nodeKeys: [] }, { id: 'interview', name: 'Interview', nodeKeys: [] }, { id: 'offer', name: 'Offer', nodeKeys: [] }] },
    })
    await navigateTo(`/library/flows/${p.id}`)
  }
  catch (e) { toast.show(toApiError(e).message) }
  finally { making.value = false }
}

// ---------- name and description: edited in place, explicit Save ----------
const renaming = ref(false)
const draft = reactive({ name: '', description: '' })
const dirty = computed(() => renaming.value && !!selected.value
  && (draft.name.trim() !== selected.value.name || draft.description.trim() !== selected.value.description))
function startRename() {
  if (!selected.value) return
  Object.assign(draft, { name: selected.value.name, description: selected.value.description })
  renaming.value = true
  nextTick(() => document.getElementById('fp-name')?.focus())
}
watch(selectedId, () => (renaming.value = false))

const saving = ref(false)
async function save() {
  const r = selected.value
  if (!r || r.builtIn || !dirty.value || saving.value) return
  if (!draft.name.trim()) return toast.show('Give the flow preset a name first.')
  saving.value = true
  try {
    await update(r.id, { name: draft.name.trim(), description: draft.description.trim() })
    renaming.value = false
  }
  catch (e) { toast.show(toApiError(e).message) }
  finally { saving.value = false }
}

const discard = () => confirm('Discard the unsaved changes to this flow preset?')
function choose(flow?: string) {
  if (dirty.value && !discard()) return
  renaming.value = false // so the route guard doesn't ask twice
  router.replace({ query: flow ? { flow } : {} })
}
onBeforeRouteLeave(() => !dirty.value || discard())

// ---------- delete ----------
const dlg = ref<HTMLDialogElement>()
const deleting = ref(false)
async function confirmDelete() {
  const r = selected.value
  if (!r || r.builtIn) return
  deleting.value = true
  try {
    await remove(r.id)
    dlg.value?.close()
    await router.replace({ query: {} })
    toast.show(`Deleted “${r.name}”`)
  }
  catch (e) { toast.show(toApiError(e).message) }
  finally { deleting.value = false }
}
</script>

<template>
  <div class="flows">
    <p class="lede">Whole flows, with their form, that a new job or a draft can start from. A job copies the flow, so changing or deleting a preset never changes jobs that already use it.</p>

    <div v-if="error && !flowPresets" class="empty" role="alert">
      <h2>The flow presets didn’t load</h2>
      <p>{{ error.message }}</p>
      <button type="button" class="btn" @click="refresh">Load again</button>
    </div>

    <div v-else class="cols">
      <section class="panel list" aria-labelledby="flows-h">
        <h2 id="flows-h" class="sr-only">Flow presets</h2>
        <ul class="rows">
          <li v-for="r in rows" :key="r.id" class="row" :class="{ current: r.id === selectedId }">
            <button type="button" class="pick" :aria-current="r.id === selectedId ? 'true' : undefined" @click="choose(r.id)">
              <span class="text">
                <b>{{ r.name }}</b>
                <span v-if="r.description" class="muted">{{ r.description }}</span>
              </span>
              <span v-if="r.builtIn" class="chip">Built in</span>
              <span v-else class="faint n">{{ counts(r) }}</span>
            </button>
          </li>
          <template v-if="!flowPresets">
            <li v-for="i in 3" :key="`sk${i}`" class="sk"><span class="skeleton" style="width: 40%" /><span class="skeleton" style="width: 70%" /></li>
          </template>
        </ul>
        <p v-if="flowPresets && !flowPresets.length" class="none">
          No flow presets yet. Start a new one here, or open a job’s Flow tab and choose <b>Flow presets › Save as flow preset…</b>
        </p>
        <div class="new-row">
          <button type="button" class="btn btn-sm btn-quiet" :disabled="making" :aria-busy="making" @click="newFlow"><span v-if="making" class="spinner" /><Icon v-else name="plus" />New flow</button>
        </div>
      </section>

      <div class="detail">
        <article v-if="selected && facts" class="card sheet" aria-labelledby="flow-h">
          <header class="sheet-head">
            <form v-if="renaming" class="naming" @submit.prevent="save" @keydown.esc="renaming = false">
              <h2 id="flow-h" class="sr-only">{{ selected.name }}</h2>
              <div class="field">
                <label for="fp-name">Name</label>
                <input id="fp-name" v-model="draft.name" required maxlength="100" autocomplete="off" placeholder="e.g. Weekend shop staff">
              </div>
              <div class="field">
                <label for="fp-desc">Description</label>
                <input id="fp-desc" v-model="draft.description" maxlength="300" placeholder="When to use it, in a line">
              </div>
              <div class="save-row">
                <button type="button" class="btn btn-quiet btn-sm" @click="renaming = false">Cancel</button>
                <button class="btn btn-sm btn-dark" :disabled="!dirty || saving" :aria-busy="saving"><span v-if="saving" class="spinner" />Save</button>
              </div>
            </form>
            <template v-else>
              <div class="title-row">
                <h2 id="flow-h">{{ selected.name }}</h2>
                <span v-if="selected.builtIn" class="chip">Built in</span>
                <template v-else>
                  <NuxtLink :to="`/library/flows/${selected.id}`" class="btn btn-sm edit-flow"><Icon name="branch" />Edit flow and form</NuxtLink>
                  <button type="button" class="btn btn-quiet btn-sm rename" @click="startRename"><Icon name="edit" />Rename…</button>
                </template>
              </div>
              <p v-if="selected.description" class="muted">{{ selected.description }}</p>
              <p v-if="selected.builtIn" class="faint small">Comes with the app, so it can’t be changed or deleted. Duplicate it to make a version you can change.</p>
            </template>
          </header>

          <div class="sheet-body">
            <section v-if="facts.named.length || facts.problems.length" class="block warns" aria-labelledby="warn-h">
              <h3 id="warn-h" class="eyebrow">Check after you use it</h3>
              <ul>
                <li v-for="n in facts.named" :key="n.key">
                  <Icon name="person" :size="16" />
                  <span v-if="n.people.every(p => p.gone)"><b>{{ n.step }}</b> goes to <span class="bad">{{ n.people.length === 1 ? 'someone who can’t' : `${n.people.length} people who can’t` }} sign in any more</span>.</span>
                  <span v-else><b>{{ n.step }}</b> goes to named people:
                    <template v-for="(p, i) in n.people" :key="p.id">{{ i ? ', ' : '' }}<span :class="{ bad: p.gone }">{{ p.name ?? (p.gone ? 'someone who can’t sign in any more' : 'a teammate') }}</span></template>.</span>
                </li>
                <li v-for="(p, i) in facts.problems" :key="i">
                  <Icon name="alert" :size="16" />
                  <span><NuxtLink v-if="p.node && !selected.builtIn" :to="`/library/flows/${selected.id}?node=${p.node}`" class="fix"><b>{{ p.where }}</b></NuxtLink><b v-else>{{ p.where }}</b>: {{ p.text }}. A job that starts from it fixes this before it can publish.</span>
                </li>
              </ul>
              <p v-if="facts.named.length" class="small">Every job that starts from this preset gets the same people until you reassign them in its flow.</p>
            </section>

            <section class="block" aria-labelledby="steps-h">
              <h3 id="steps-h" class="eyebrow">{{ plural(facts.steps.length, 'step') }}</h3>
              <ol class="steps">
                <li v-for="n in facts.steps" :key="n.key" :data-kind="nodeMeta(n.type).slot">
                  <Icon :name="nodeMeta(n.type).icon" :size="14" />{{ nodeLabel(n) }}
                </li>
              </ol>
            </section>

            <section class="block" aria-labelledby="form-h">
              <h3 id="form-h" class="eyebrow">Application form · {{ plural(facts.fields.length, 'field') }}</h3>
              <p v-if="facts.fields.length">{{ facts.fields.join(', ') }}</p>
              <p v-else class="muted">No fields. Candidates only give their name and email.</p>
            </section>

            <section class="block" aria-labelledby="reads-h">
              <h3 id="reads-h" class="eyebrow">Reads from each job</h3>
              <template v-if="facts.reads.length">
                <p class="chips"><span v-for="l in facts.reads" :key="l" class="chip">{{ l }}</span></p>
                <p class="faint small">Fill these in on each job’s Details tab. The job says which are empty.</p>
              </template>
              <p v-else class="muted">Only the title and openings, which every job has.</p>
            </section>
          </div>

          <footer class="foot">
            <button v-if="!selected.builtIn" type="button" class="btn btn-danger btn-sm" @click="dlg?.showModal()"><Icon name="trash" />Delete…</button>
            <button type="button" class="btn btn-sm" :disabled="duplicating" :aria-busy="duplicating" @click="duplicate"><Icon name="copy" />Duplicate</button>
            <NuxtLink :to="{ path: '/jobs', query: { new: selected.id } }" class="btn btn-primary"><Icon name="plus" />New job from this flow</NuxtLink>
          </footer>
        </article>

        <div v-else-if="gone" class="pick-hint" role="status">
          <p>This flow preset was deleted. Jobs that started from it keep their flows.</p>
          <p><button type="button" class="btn btn-sm" @click="choose()">Back to the list</button></p>
        </div>
      </div>
    </div>

    <dialog ref="dlg" class="dialog" closedby="any" aria-labelledby="del-h">
      <div class="dialog-body">
        <h2 id="del-h">Delete “{{ selected?.name }}”?</h2>
        <p class="muted">It leaves the library and the New job list. Jobs already started from it keep their flows. You can’t undo this.</p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="dlg?.close()">Keep it</button>
        <button type="button" class="btn btn-danger" :disabled="deleting" :aria-busy="deleting" @click="confirmDelete">Delete flow preset</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.lede { color: var(--ink-2); margin-bottom: 20px; max-width: 75ch; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(400px, 520px); gap: 24px; align-items: start; }
.list { padding: 6px; min-width: 0; }
.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.row { border-radius: 12px; transition: background var(--t-micro) var(--ease); }
.row:hover { background: var(--hover); }
.row.current { background: var(--accent-tint); }
/* the built-in sits apart from the company's own presets */
.row:first-child { margin-bottom: 4px; }
.row:first-child::after { content: ""; display: block; height: 1px; margin: 4px 12px 0; background: var(--line); }
.pick { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 12px; color: var(--ink); }
.text { flex: 1; display: grid; min-width: 0; }
.text b { font-weight: 600; overflow-wrap: anywhere; }
.text .muted { font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.n { flex: none; font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
.sk { display: grid; gap: 8px; padding: 14px; }
.sk .skeleton { height: 12px; }
.none { padding: 12px 14px 14px; font-size: var(--t-sm); color: var(--ink-2); text-wrap: pretty; }
.none b { font-weight: 600; color: var(--ink); }
.new-row { padding: 4px 6px 6px; border-top: 1px solid var(--line); margin-top: 4px; }

.detail { position: sticky; top: 24px; min-width: 0; }
/* as tall as its content: nothing (least of all what a job must fill in) hides in an inner scroll */
.sheet { display: grid; padding: 0; overflow: hidden; }
.sheet-head { padding: 22px 20px 16px; display: grid; gap: 6px; }
.title-row { display: flex; align-items: center; gap: 10px; }
.title-row h2 { font-size: var(--t-xl); overflow-wrap: anywhere; min-width: 0; }
.edit-flow { margin-left: auto; flex: none; }
.rename { flex: none; }
.naming { display: grid; gap: 12px; }
.save-row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.small { font-size: var(--t-sm); text-wrap: pretty; }
.block { padding: 14px 20px 16px; border-top: 1px solid var(--line); display: grid; gap: 10px; }
/* the steps read as a sequence: wrapped tokens, a person's steps in the accent as on the canvas */
.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
.steps li { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px; border-radius: var(--r-pill); background: var(--sunk); font-size: var(--t-sm); font-weight: 500; color: var(--ink); }
.steps li svg { flex: none; color: var(--ink-2); }
.steps li[data-kind="accent"] { background: var(--accent-tint); }
.steps li[data-kind="accent"] svg { color: var(--accent-ink); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.warns { background: var(--warn-tint); }
.warns ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.warns li { display: flex; gap: 10px; align-items: flex-start; font-size: var(--t-sm); text-wrap: pretty; }
.warns li svg { flex: none; margin-top: 2px; color: var(--warn); }
.warns b { font-weight: 600; }
/* a preset's problems can be fixed in its editor: the step name opens it there */
.warns .fix { color: inherit; }
.warns .bad { color: var(--bad); font-weight: 600; }
.foot .btn-danger { margin-right: auto; }
.foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--line); background: var(--surface); }
.pick-hint { display: grid; gap: 10px; padding: 28px 24px; border: 1.5px dashed var(--line-2); border-radius: var(--r-card); color: var(--ink-2); }
@media (max-height: 600px) { .detail { position: static; } }
</style>
