<script setup lang="ts">
useHead({ title: 'Offer letters · Library' })
const route = useRoute()
const router = useRouter()
const toast = useToast()

interface Template { id: string | null, name: string, body: string, builtIn?: boolean, createdAt?: string }

const list = ref<Template[] | null>(null)
const error = ref('')
async function refresh() {
  error.value = ''
  try { list.value = await api<Template[]>('/api/offer-templates') }
  catch (e) { error.value = toApiError(e).message }
}
refresh()

// The holes a letter can use; filled when an offer is made. Samples drive the preview.
const HOLES = [
  { path: 'candidate.first_name', label: 'First name', sample: 'Maya' },
  { path: 'job.title', label: 'Job title', sample: 'Shop supervisor' },
  { path: 'company.name', label: 'Company', sample: 'Northwind Bakery' },
  { path: 'offer.salary', label: 'Salary', sample: '£28,000 a year' },
  { path: 'offer.start_date', label: 'Start date', sample: '2 November 2026' },
  { path: 'offer.location', label: 'Location', sample: 'Leeds, Kirkgate shop' },
]
const KNOWN = new Set(HOLES.map(h => h.path))

// ?offer=<id> | standard | new; else the first in the list
const key = (t: Template) => t.id ?? 'standard'
const selectedKey = computed(() => (route.query.offer as string | undefined) ?? (list.value?.[0] ? key(list.value[0]) : undefined))
const selected = computed(() => list.value?.find(t => key(t) === selectedKey.value))
const isNew = computed(() => selectedKey.value === 'new')
const gone = computed(() => !!list.value && !isNew.value && !selected.value)

const draft = reactive({ name: '', body: '' })
const mode = ref<'write' | 'preview'>('write')
const pristine = ref('')
const snap = () => JSON.stringify([draft.name, draft.body])
const dirty = computed(() => snap() !== pristine.value)
// a new letter starts blank, or from the built-in when it was copied (then it starts unsaved)
let seed: Template | null = null
function open() {
  const t = isNew.value ? null : selected.value
  draft.name = t?.name ?? ''
  draft.body = t?.body ?? ''
  pristine.value = snap()
  if (isNew.value && seed) {
    draft.name = `${seed.name} (copy)`
    draft.body = seed.body
    seed = null
  }
  mode.value = 'write'
}
watch([selectedKey, () => !!list.value], open, { immediate: true })

function choose(k?: string) {
  if (dirty.value && !confirm('Discard the unsaved changes to this letter?')) return
  pristine.value = snap()
  router.replace({ query: k ? { offer: k } : {} })
}
onBeforeRouteLeave(() => !dirty.value || confirm('Discard the unsaved changes to this letter?'))

// holes that aren't on the list come out blank in the letter
const unknown = computed(() => [...new Set([...draft.body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]!).filter(p => !KNOWN.has(p)))])
// built here: a {{…}} inside the template's own {{ }} would end the interpolation early
const unknownText = computed(() => unknown.value.map(p => `{{${p}}}`).join(', '))
const preview = computed(() => renderMarkdown(draft.body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => HOLES.find(h => h.path === p)?.sample ?? '')))

const ta = ref<HTMLTextAreaElement>()
function insert(path: string) {
  mode.value = 'write'
  nextTick(() => {
    const el = ta.value!
    el.focus()
    const tag = `{{${path}}}`
    // execCommand keeps the browser's undo; setRangeText where it's gone
    if (!document.execCommand('insertText', false, tag)) el.setRangeText(tag, el.selectionStart, el.selectionEnd, 'end')
    draft.body = el.value
  })
}

const readOnly = computed(() => !!selected.value?.builtIn)
const saving = ref(false)
const nameError = ref('')
async function save() {
  const name = draft.name.trim()
  nameError.value = name ? '' : 'Give the letter a name.'
  if (nameError.value || !draft.body.trim() || saving.value) return
  saving.value = true
  try {
    const body = { name, body: draft.body }
    if (selected.value?.id) {
      await api(`/api/offer-templates/${selected.value.id}`, { method: 'PATCH', body })
      await refresh()
      pristine.value = snap()
      toast.show(`Saved “${name}”. Offers already made keep their words.`)
    }
    else {
      const t = await api<Template>('/api/offer-templates', { method: 'POST', body })
      await refresh()
      pristine.value = snap()
      await router.replace({ query: { offer: t.id! } })
      toast.show(`Added “${name}”`)
    }
  }
  catch (e) { toast.show(toApiError(e).message) }
  finally { saving.value = false }
}

// ---------- copy of the built-in: an editable draft, saved as a new letter ----------
function copyBuiltIn() {
  seed = selected.value!
  router.replace({ query: { offer: 'new' } })
}

// ---------- delete ----------
const dlg = ref<HTMLDialogElement>()
const deleting = ref(false)
async function confirmDelete() {
  const t = selected.value
  if (!t?.id) return
  deleting.value = true
  try {
    await api(`/api/offer-templates/${t.id}`, { method: 'DELETE' })
    dlg.value?.close()
    pristine.value = snap()
    await router.replace({ query: {} })
    await refresh()
    toast.show(`Deleted “${t.name}”`)
  }
  catch (e) { toast.show(toApiError(e).message) }
  finally { deleting.value = false }
}
</script>

<template>
  <div class="offers">
    <p class="lede">The letters you send with a job offer. Each offer copies its letter, so editing one here never changes offers already sent.</p>

    <div v-if="error && !list" class="empty" role="alert">
      <h2>The offer letters didn’t load</h2>
      <p>{{ error }}</p>
      <button type="button" class="btn" @click="refresh"><Icon name="retry" />Try again</button>
    </div>

    <div v-else class="cols">
      <section class="panel list" aria-labelledby="ol-h">
        <header class="list-head">
          <h2 id="ol-h">Letters <span v-if="list" class="faint">{{ list.filter(t => !t.builtIn).length }}</span></h2>
          <button type="button" class="btn btn-sm btn-quiet" @click="choose('new')"><Icon name="plus" />New letter</button>
        </header>
        <ul class="rows">
          <template v-if="!list">
            <li v-for="i in 2" :key="i" class="sk"><span class="skeleton" style="width: 40%" /><span class="skeleton" style="width: 70%" /></li>
          </template>
          <li v-for="t in list" v-else :key="key(t)" class="row" :class="{ current: key(t) === selectedKey }">
            <button type="button" class="pick" :aria-current="key(t) === selectedKey ? 'true' : undefined" @click="choose(key(t))">
              <span class="ico"><Icon name="file" :size="16" /></span>
              <span class="text">
                <b>{{ t.name }}</b>
                <span class="muted">{{ t.body.replace(/\s+/g, ' ').slice(0, 120) }}</span>
              </span>
              <span v-if="t.builtIn" class="chip">Built in</span>
            </button>
          </li>
          <li v-if="isNew" class="row current">
            <span class="pick"><span class="ico"><Icon name="plus" :size="16" /></span><span class="text"><b>{{ draft.name.trim() || 'New letter' }}</b><span class="muted">Not saved yet</span></span></span>
          </li>
        </ul>
        <p v-if="list?.length === 1 && list[0]!.builtIn" class="none">
          Standard offer is ready to use. Copy it to make one in your own words; once you have your own letters, they replace it here.
        </p>
      </section>

      <div class="detail">
        <article v-if="selected || isNew" class="card sheet" aria-labelledby="ol-name-h">
          <h2 id="ol-name-h" class="sr-only">{{ isNew ? 'New letter' : selected?.name }}</h2>
          <div class="sheet-body">
            <template v-if="readOnly">
              <div class="title-row">
                <h3>{{ selected!.name }}</h3>
                <span class="chip">Built in</span>
              </div>
              <p class="faint small">Comes with the app, so it can’t be changed. Copy it to make a letter you can edit.</p>
            </template>
            <div v-else class="field">
              <label for="ol-name">Name</label>
              <input id="ol-name" v-model="draft.name" maxlength="80" autocomplete="off" placeholder="Part-time offer" :aria-invalid="!!nameError || undefined" :aria-describedby="nameError ? 'ol-name-e' : undefined">
              <p v-if="nameError" id="ol-name-e" class="error"><Icon name="alert" :size="14" />{{ nameError }}</p>
            </div>

            <div class="field">
              <div class="body-head">
                <label for="ol-body">Letter</label>
                <div class="seg" role="radiogroup" aria-label="Letter view">
                  <label><input v-model="mode" type="radio" name="ol-mode" value="write"><span>Write</span></label>
                  <label><input v-model="mode" type="radio" name="ol-mode" value="preview"><span>Preview</span></label>
                </div>
              </div>
              <textarea
                v-show="mode === 'write'" id="ol-body" ref="ta" v-model="draft.body" rows="16" maxlength="20000"
                :readonly="readOnly" spellcheck="true" aria-describedby="ol-holes-h"
              />
              <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapes all HTML first -->
              <div v-if="mode === 'preview'" class="prose preview" v-html="preview || '<p class=&quot;faint&quot;>Nothing to preview yet.</p>'" />
              <p v-if="mode === 'preview'" class="hint">With made-up details. The candidate sees theirs.</p>
            </div>

            <div v-if="!readOnly" class="holes">
              <p id="ol-holes-h" class="hint">Click to put a detail where the cursor is. Each one is filled in when you make the offer.</p>
              <ul>
                <li v-for="h in HOLES" :key="h.path">
                  <button type="button" class="hole" @mousedown.prevent @click="insert(h.path)"><Icon name="braces" :size="14" />{{ h.label }}</button>
                </li>
              </ul>
              <p v-if="unknown.length" class="warn"><Icon name="alert" :size="14" />{{ unknownText }} isn’t a detail the letter can fill, so it will come out blank.</p>
            </div>
          </div>

          <footer class="foot">
            <template v-if="readOnly">
              <button type="button" class="btn btn-primary" @click="copyBuiltIn"><Icon name="copy" />Copy and edit</button>
            </template>
            <template v-else>
              <button v-if="selected?.id" type="button" class="btn btn-danger btn-sm" @click="dlg?.showModal()"><Icon name="trash" />Delete…</button>
              <button v-if="isNew" type="button" class="btn btn-sm btn-quiet" @click="choose()">Cancel</button>
              <span class="status" aria-live="polite">{{ dirty ? 'Unsaved' : selected ? 'Saved' : '' }}</span>
              <button type="button" class="btn btn-primary" :disabled="saving || !draft.body.trim() || (!dirty && !isNew)" :aria-busy="saving" @click="save">
                <span v-if="saving" class="spinner" />{{ isNew ? 'Add letter' : 'Save letter' }}
              </button>
            </template>
          </footer>
        </article>

        <div v-else-if="gone" class="pick-hint" role="status">
          <p>This letter was deleted. Offers made with it keep their words.</p>
          <p><button type="button" class="btn btn-sm" @click="choose()">Back to the list</button></p>
        </div>
      </div>
    </div>

    <dialog ref="dlg" class="dialog" closedby="any" aria-labelledby="ol-del-h">
      <div class="dialog-body">
        <h2 id="ol-del-h">Delete “{{ selected?.name }}”?</h2>
        <p class="muted">It leaves the library. Offers already made with it keep their words. You can’t undo this.</p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="dlg?.close()">Keep it</button>
        <button type="button" class="btn btn-danger" :disabled="deleting" :aria-busy="deleting" @click="confirmDelete">Delete letter</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
/* the Flows tab's list beside its sheet, so the three Library tabs read as one place */
.lede { color: var(--ink-2); margin-bottom: 20px; max-width: 75ch; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(440px, 600px); gap: 24px; align-items: start; }
.list { padding: 6px; min-width: 0; }
.list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 10px 8px 12px; }
.list-head h2 { font-size: var(--t-lg); }
.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.sk { display: grid; gap: 8px; padding: 14px; }
.sk .skeleton { height: 14px; }
.row { border-radius: 12px; transition: background var(--t-micro) var(--ease); }
.row:hover { background: var(--hover); }
.row.current { background: var(--accent-tint); }
.pick { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 12px; color: var(--ink); }
span.pick { cursor: default; }
.ico { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 10px; background: var(--sunk); color: var(--ink-2); }
.row.current .ico { background: var(--surface); color: var(--accent-ink); }
.text { flex: 1; display: grid; min-width: 0; }
.text b { font-weight: 600; overflow-wrap: anywhere; }
.text .muted { font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.none { padding: 8px 12px 6px; font-size: var(--t-sm); color: var(--ink-2); max-width: 60ch; }

.detail { position: sticky; top: 24px; min-width: 0; }
.sheet { display: grid; overflow: hidden; max-height: calc(100dvh - 132px); grid-template-rows: minmax(0, 1fr) auto; }
.sheet-body { overflow-y: auto; padding: 20px; display: grid; gap: 18px; align-content: start; }
.title-row { display: flex; align-items: center; gap: 10px; }
.title-row h3 { font-size: var(--t-lg); }
.small { font-size: var(--t-sm); }
.body-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.body-head > label { font-weight: 600; font-size: var(--t-sm); }
.body-head .seg { font-size: var(--t-sm); }
textarea { font-variant-ligatures: none; line-height: 1.55; resize: vertical; }
textarea[readonly] { background: var(--sunk); color: var(--ink-2); }
.preview { padding: 16px 18px; border: 1px dashed var(--line-2); border-radius: var(--r-field); background: var(--bg); min-height: 200px; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }
.holes { display: grid; gap: 8px; }
.holes ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
/* a detail is a hole in the letter: drawn like the {{ }} it inserts, in the accent ink the canvas uses for inserts */
.hole {
  display: inline-flex; align-items: center; gap: 6px; height: var(--h-sm); padding: 0 12px; border: 1px dashed var(--line-2); border-radius: var(--r-pill);
  background: var(--surface); color: var(--accent-ink); font-weight: 600; font-size: var(--t-sm); cursor: pointer;
  transition: background var(--t-micro) var(--ease), border-color var(--t-micro) var(--ease);
}
.hole:hover { background: var(--accent-tint); border-color: var(--accent); }
.warn { display: flex; gap: 6px; align-items: flex-start; font-size: var(--t-sm); color: var(--warn); font-weight: 500; }
.warn svg { margin-top: 3px; flex: none; }
.foot { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface); }
.foot .status { margin-left: auto; font-size: var(--t-sm); color: var(--ink-2); }
.foot > .btn-primary:only-child { margin-left: auto; }
.pick-hint { display: grid; gap: 8px; padding: 28px 24px; border: 1.5px dashed var(--line-2); border-radius: var(--r-card); color: var(--ink-2); }
@media (max-height: 600px) { .detail { position: static; } }
</style>
