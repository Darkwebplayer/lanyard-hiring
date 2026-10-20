<script setup lang="ts">
import type { JobStatus } from '~/composables/useJob'

interface JobRow {
  id: string, title: string, status: JobStatus, openings: number, closesAt: string | null
  ownerId: string, ownerName: string, createdAt: string, publishedVersion: number | null, hasDraft: boolean
  active: number, stopped: number, hired: number
}

useHead({ title: 'Jobs' })
const route = useRoute()
const router = useRouter()

const jobs = ref<JobRow[] | null>(null)
const loadError = ref<string | null>(null)
async function load() {
  loadError.value = null
  try { jobs.value = await api<JobRow[]>('/api/jobs') }
  catch (e) { loadError.value = toApiError(e).message }
}
onMounted(load)

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Live' },
  { value: 'draft', label: 'Draft' },
  { value: 'closed', label: 'Closed' },
  { value: 'archived', label: 'Archived' },
] as const
const filter = computed(() => FILTERS.some(f => f.value === route.query.status) ? route.query.status as string : 'all')
const count = (f: string) => jobs.value?.filter(j => f === 'all' || j.status === f).length ?? 0
const shown = computed(() => jobs.value?.filter(j => filter.value === 'all' || j.status === filter.value) ?? [])
const setFilter = (v: string) => router.replace({ query: { ...route.query, status: v === 'all' ? undefined : v } })

// Closing dates only matter while the job is live.
function closes(j: JobRow) {
  if (!j.closesAt) return { text: '–', warn: false }
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(new Date(j.closesAt)) - day(new Date())) / 86_400_000)
  if (j.status !== 'open') return { text: fmtDate(j.closesAt), warn: false }
  if (new Date(j.closesAt).getTime() < Date.now()) return { text: `Closed ${fmtDate(j.closesAt)}`, warn: true }
  if (days === 0) return { text: 'Closes today', warn: true }
  if (days === 1) return { text: 'Closes tomorrow', warn: true }
  if (days <= 7) return { text: `Closes in ${plural(days, 'day')}`, warn: true }
  return { text: fmtDate(j.closesAt), warn: false }
}

// ---- new job ----
const dlg = ref<HTMLDialogElement>()
const form = reactive({ title: '', openings: 1, from: 'standard_hire' as 'standard_hire' | 'blank' | 'job' | 'preset', jobId: '', presetId: '' })
const creating = ref(false)
const createError = ref<string | null>(null)
const presetGone = ref(false)
const copyable = computed(() => jobs.value?.filter(j => j.status !== 'archived') ?? [])
const { flowPresets, error: presetsError, refresh: refreshPresets } = useFlowPresets()
refreshPresets()
const counts = (p: { form: unknown[], workflow: { nodes: { type: string }[] } }) =>
  `${plural(p.workflow.nodes.filter(n => n.type !== 'application_received').length, 'step')} · ${plural(p.form.length, 'field')}`
// one radio group: the built-ins, then each preset as preset:<id>
const choice = computed({
  get: () => (form.from === 'preset' ? `preset:${form.presetId}` : form.from),
  set: (v: string) => v.startsWith('preset:') ? Object.assign(form, { from: 'preset', presetId: v.slice(7) }) : (form.from = v as typeof form.from),
})

function openNew(start = 'standard') {
  const preset = flowPresets.value?.find(p => p.id === start)
  presetGone.value = start !== 'standard' && !preset
  Object.assign(form, { title: '', openings: 1, from: preset ? 'preset' : 'standard_hire', presetId: preset?.id ?? '', jobId: copyable.value[0]?.id ?? '' })
  createError.value = null
  dlg.value?.showModal()
}
// ?new=<preset id|standard> from the library: open the dialog once the jobs and presets are in
watch([() => route.query.new, jobs, () => flowPresets.value ?? presetsError.value], ([n, j, p]) => {
  if (typeof n !== 'string' || !j || !p) return
  router.replace({ query: { ...route.query, new: undefined } })
  openNew(n)
}, { immediate: true })
async function create() {
  creating.value = true
  createError.value = null
  try {
    const from = form.from === 'job' ? { kind: 'job', jobId: form.jobId } : form.from === 'preset' ? { kind: 'preset', presetId: form.presetId } : { kind: form.from }
    const { job } = await api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { title: form.title, openings: form.openings, from } })
    dlg.value?.close()
    await navigateTo(form.from === 'preset' ? `/jobs/${job.id}/details?check=1` : `/jobs/${job.id}/details`)
  }
  catch (e) { createError.value = toApiError(e).message }
  finally { creating.value = false }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>Jobs</h1>
      <div v-if="jobs?.length" class="actions">
        <button class="btn btn-primary" @click="openNew()"><Icon name="plus" />New job</button>
      </div>
    </header>

    <div v-if="loadError" class="form-error" role="alert">
      <Icon name="alert" />{{ loadError }} <button class="btn btn-sm" @click="load">Retry</button>
    </div>

    <div v-else-if="!jobs" class="panel" aria-busy="true">
      <div v-for="i in 6" :key="i" class="sk-row"><span class="skeleton" style="width: 34%" /><span class="skeleton" style="width: 9%" /><span class="skeleton" style="width: 14%" /><span class="skeleton" style="width: 16%" /></div>
    </div>

    <section v-else-if="!jobs.length" class="panel empty">
      <Icon name="jobs" :size="28" />
      <h2>No jobs yet</h2>
      <p>A job holds the role, its application form and the flow each candidate goes through. Publish it and share the apply link.</p>
      <button class="btn btn-primary" @click="openNew()"><Icon name="plus" />New job</button>
    </section>

    <template v-else>
      <div class="seg" role="radiogroup" aria-label="Show jobs">
        <label v-for="f in FILTERS" :key="f.value">
          <input type="radio" name="status" :value="f.value" :checked="filter === f.value" @change="setFilter(f.value)">
          <span>{{ f.label }} <b class="n">{{ count(f.value) }}</b></span>
        </label>
      </div>

      <div class="panel table-wrap">
        <table class="table">
          <thead>
            <tr><th>Job</th><th>Status</th><th>Candidates</th><th class="num">Hired</th><th>Closes</th><th>Owner</th><th><span class="sr-only">Apply link</span></th></tr>
          </thead>
          <tbody>
            <tr v-for="j in shown" :key="j.id">
              <td class="title">
                <NuxtLink :to="`/jobs/${j.id}`" class="row-link">{{ j.title }}</NuxtLink>
                <span v-if="j.hasDraft && j.publishedVersion" class="changes"><Icon name="edit" :size="12" />Unpublished changes</span>
              </td>
              <td><JobStatusChip :status="j.status" /></td>
              <td>
                <span v-if="j.publishedVersion" class="cands">
                  <NuxtLink :to="`/jobs/${j.id}`" class="cand-n">{{ j.active }} active</NuxtLink>
                  <NuxtLink v-if="j.stopped" :to="`/jobs/${j.id}`" class="chip chip-bad"><Icon name="stop" />{{ j.stopped }} stopped</NuxtLink>
                </span>
                <span v-else class="faint">Not published</span>
              </td>
              <td class="num nowrap">{{ j.hired }} <span class="faint">of {{ j.openings }}</span></td>
              <td>
                <span v-if="closes(j).warn" class="chip chip-warn"><Icon name="clock" />{{ closes(j).text }}</span>
                <span v-else :class="{ faint: !j.closesAt }">{{ closes(j).text }}</span>
              </td>
              <td><span class="owner"><Avatar :name="j.ownerName" :size="24" />{{ j.ownerName }}</span></td>
              <td class="link-cell"><JobApplyActions v-if="j.status === 'open'" :job-id="j.id" compact /></td>
            </tr>
            <tr v-if="!shown.length">
              <td colspan="7" class="none">No {{ FILTERS.find(f => f.value === filter)!.label.toLowerCase() }} jobs.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <dialog ref="dlg" class="dialog" aria-labelledby="new-job-title" @click.self="dlg?.close()">
      <form @submit.prevent="create">
        <div class="dialog-body">
          <h2 id="new-job-title">New job</h2>
          <div class="field">
            <label for="nj-title">Title</label>
            <input id="nj-title" v-model="form.title" required maxlength="200" autocomplete="off" placeholder="e.g. Senior Product Designer">
          </div>
          <div class="field openings">
            <label for="nj-openings">Openings</label>
            <input id="nj-openings" v-model.number="form.openings" type="number" min="1" max="10000" required>
          </div>
          <fieldset class="field">
            <legend class="legend">Start from</legend>
            <p v-if="presetGone" class="gone" role="status"><Icon name="alert" :size="14" />That flow preset was deleted, so this starts from Standard hire.</p>
            <label class="check"><input v-model="choice" type="radio" value="standard_hire"><span><b>Standard hire</b><span class="hint">CV read, AI review, shortlist, interview, offer. Already wired up.</span></span></label>
            <label class="check"><input v-model="choice" type="radio" value="blank"><span><b>Blank flow</b><span class="hint">Only the start. You build every step.</span></span></label>
            <div v-if="flowPresets?.length" class="presets" role="group" aria-labelledby="nj-presets">
              <span id="nj-presets" class="eyebrow">Your flow presets</span>
              <label v-for="p in flowPresets" :key="p.id" class="check"><input v-model="choice" type="radio" :value="`preset:${p.id}`"><span><b>{{ p.name }} <span class="n">{{ counts(p) }}</span></b><span v-if="p.description" class="hint">{{ p.description }}</span></span></label>
            </div>
            <label class="check"><input v-model="choice" type="radio" value="job" :disabled="!copyable.length"><span><b>Copy another job</b><span class="hint">Its form and flow, not its candidates.</span></span></label>
            <select v-if="form.from === 'job'" v-model="form.jobId" aria-label="Job to copy" required class="copy-from">
              <option v-for="j in copyable" :key="j.id" :value="j.id">{{ j.title }}</option>
            </select>
          </fieldset>
          <p v-if="createError" class="form-error" role="alert"><Icon name="alert" />{{ createError }}</p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn btn-quiet" @click="dlg?.close()">Cancel</button>
          <button class="btn btn-primary" :aria-busy="creating" :disabled="creating"><span v-if="creating" class="spinner" />Create job</button>
        </div>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.seg { margin-bottom: 16px; }
.n { font-weight: 600; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.seg input:checked + span .n { color: var(--ink-2); }
.title { min-width: 0; max-width: 46ch; }
.title .row-link { display: block; }
.changes { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; font-size: var(--t-xs); font-weight: 600; color: var(--warn); }
.owner { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.none { text-align: center; color: var(--ink-2); padding: 32px; }
.sk-row { display: flex; gap: 32px; padding: 16px; border-bottom: 1px solid var(--line); }
.sk-row:last-child { border-bottom: 0; }
.sk-row .skeleton { height: 14px; }
.form-error .btn { margin-left: auto; }
.openings input { width: 120px; }
fieldset.field { gap: 10px; }
/* radios read as choices, not as field labels (the global .field > label rule), same as the grouped presets */
.field > .check { font-weight: 400; font-size: var(--t-md); }
.check > span { display: grid; gap: 1px; }
.check b { font-weight: 600; }
.check b .n { margin-left: 4px; font-weight: 400; font-size: var(--t-sm); color: var(--ink-2); }
.check .hint { font-size: var(--t-sm); color: var(--ink-2); }
.presets { display: grid; gap: 10px; max-height: min(260px, 32dvh); overflow-y: auto; padding: 8px 2px 2px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.gone { display: flex; align-items: center; gap: 6px; font-size: var(--t-sm); color: var(--warn); font-weight: 500; }
.copy-from { margin-left: 28px; width: calc(100% - 28px); }
.cands { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cand-n { color: var(--ink); text-decoration: none; font-variant-numeric: tabular-nums; }
.cand-n:hover { text-decoration: underline; }
.cands .chip { text-decoration: none; }
.link-cell { width: 1%; white-space: nowrap; text-align: right; padding-block: 0; }
</style>
