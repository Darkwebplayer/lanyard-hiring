<script setup lang="ts">
// The Request documents checklist: what the candidate uploaded, what the team ticked off, and the link.
// Renders nothing when the flow never asked this candidate for documents.
const props = defineProps<{ applicationId: string, firstName: string, stamp?: unknown }>()
const emit = defineEmits<{ changed: [] }>()

interface Request {
  id: string, nodeKey: string, runId: string, runStatus: string, canAct: boolean, url: string | null
  documents: { label: string, required: boolean, received: { at: string, fileName: string | null, by: string | null, note: string | null } | null }[]
}
const reqs = ref<Request[] | null>(null)
const loadErr = ref('')
async function load() {
  try { reqs.value = await api<Request[]>(`/api/applications/${props.applicationId}/documents`); loadErr.value = '' }
  catch (e) { loadErr.value = toApiError(e).message }
}
watch(() => [props.applicationId, props.stamp], load, { immediate: true }) // stamp: the page reloaded, so a step may have started
defineExpose({ load })

const count = (r: Request) => {
  const req = r.documents.filter(x => x.required)
  return `${req.filter(x => x.received).length} of ${req.length} required`
}

// ---- mark received (with an optional note) ----
const marking = ref<{ id: string, index: number } | null>(null)
const note = ref('')
const busy = ref(false)
const err = ref('')
function startMark(r: Request, index: number) {
  marking.value = { id: r.id, index }
  note.value = ''
  err.value = ''
  nextTick(() => document.getElementById(`dn-${r.id}-${index}`)?.focus())
}
async function mark() {
  busy.value = true
  err.value = ''
  try {
    const { allIn } = await api<{ allIn: boolean }>(`/api/documents/${marking.value!.id}/received`, { method: 'POST', body: { index: marking.value!.index, note: note.value || undefined } })
    marking.value = null
    await load()
    if (allIn) emit('changed') // the step may have finished and the flow moved on
  }
  catch (e) { err.value = toApiError(e).message }
  finally { busy.value = false }
}

// ---- copy link, reminder ----
const said = ref<Record<string, string>>({})
let timer: ReturnType<typeof setTimeout> | undefined
const flash = (id: string, text: string) => {
  said.value = { ...said.value, [id]: text }
  clearTimeout(timer)
  timer = setTimeout(() => (said.value = {}), 3000)
}
async function copy(r: Request) {
  flash(r.id, (await copyText(`${location.origin}${r.url}`)) ? 'Link copied' : 'Copy failed. Open the link and copy it from the address bar.')
}
const reminding = ref<string | null>(null)
async function remind(r: Request) {
  reminding.value = r.id
  try {
    const { sent } = await api<{ sent: boolean }>(`/api/documents/${r.id}/remind`, { method: 'POST' })
    flash(r.id, sent ? `Reminder sent to ${props.firstName}` : 'Already reminded today')
  }
  catch (e) { flash(r.id, toApiError(e).message) }
  finally { reminding.value = null }
}
const missing = (r: Request) => r.documents.some(x => x.required && !x.received)
</script>

<template>
  <p v-if="loadErr" class="muted small">The documents didn’t load. Reload the page to try again.</p>
  <section v-for="r in reqs ?? []" :key="r.id" class="panel docs" :aria-labelledby="`docs-h-${r.id}`">
    <div class="dhead">
      <h2 :id="`docs-h-${r.id}`" class="sec">Documents</h2>
      <span class="faint small">{{ count(r) }}</span>
    </div>
    <ul class="list">
      <li v-for="(d, i) in r.documents" :key="i" :class="{ optional: !d.required && !d.received }">
        <div class="row">
          <span><Icon :name="d.received ? 'check' : 'clock'" :size="14" :class="d.received ? 'ok' : 'wait'" /> {{ d.label }}<template v-if="!d.required"> · optional</template></span>
          <a v-if="d.received?.fileName && r.canAct" :href="`/api/documents/${r.id}/files/${i}`" download class="small file">{{ d.received.fileName }}</a>
          <span v-else-if="d.received?.fileName" class="small muted">{{ d.received.fileName }}</span>
          <span v-else-if="d.received" class="small muted">Ticked by {{ d.received.by ?? 'someone' }}<template v-if="d.received.note">: “{{ d.received.note }}”</template></span>
          <button v-else-if="r.canAct && d.required && !(marking?.id === r.id && marking.index === i)" type="button" class="btn btn-sm" @click="startMark(r, i)">Mark received…</button>
        </div>
        <form v-if="marking?.id === r.id && marking.index === i" class="mark" @submit.prevent="mark">
          <label :for="`dn-${r.id}-${i}`" class="small">Note <span class="faint">(optional)</span></label>
          <input :id="`dn-${r.id}-${i}`" v-model="note" maxlength="500" placeholder="e.g. Seen the original">
          <div class="acts">
            <button type="button" class="btn btn-sm btn-quiet" @click="marking = null">Cancel</button>
            <button class="btn btn-sm btn-primary" :disabled="busy" :aria-busy="busy"><span v-if="busy" class="spinner" />Mark received</button>
          </div>
          <p v-if="err" class="form-error" role="alert"><Icon name="alert" :size="14" />{{ err }}</p>
        </form>
      </li>
    </ul>
    <div v-if="r.url" class="acts">
      <button type="button" class="btn btn-sm" @click="copy(r)"><Icon name="copy" />Copy link</button>
      <button v-if="missing(r)" type="button" class="btn btn-sm" :disabled="reminding === r.id" :aria-busy="reminding === r.id" @click="remind(r)">
        <span v-if="reminding === r.id" class="spinner" /><Icon v-else name="mail" />Send a reminder
      </button>
    </div>
    <p v-if="said[r.id]" class="small muted" aria-live="polite">{{ said[r.id] }}</p>
  </section>
</template>

<style scoped>
.docs { padding: 18px; display: grid; gap: 10px; }
.dhead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.sec { font-size: var(--t-lg); margin: 0; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 10px 0; border-top: 1px solid var(--line); display: grid; gap: 8px; }
.list li.optional { color: var(--ink-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; overflow-wrap: anywhere; }
.row svg { display: inline; vertical-align: -2px; }
.ok { color: var(--ok); }
.wait { color: var(--ink-3); }
.file { font-weight: 600; }
.mark { display: grid; gap: 6px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-start; }
.mark .acts { justify-content: flex-end; }
.small { font-size: var(--t-sm); }
</style>
