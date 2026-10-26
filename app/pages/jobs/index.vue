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

// ---- new job: the wizard; ?new=<preset id|standard> from the library opens it once the jobs and presets are in ----
const wizard = ref<{ open: (start?: string) => void }>()
const copyable = computed(() => jobs.value?.filter(j => j.status !== 'archived') ?? [])
const { flowPresets, error: presetsError, refresh: refreshPresets } = useFlowPresets()
refreshPresets()
watch([() => route.query.new, jobs, () => flowPresets.value ?? presetsError.value, wizard], ([n, j, p, w]) => {
  if (typeof n !== 'string' || !j || !p || !w) return
  router.replace({ query: { ...route.query, new: undefined } })
  w.open(n)
}, { immediate: true })
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>Jobs</h1>
      <div v-if="jobs?.length" class="actions">
        <button class="btn btn-primary" data-tour="new-job" @click="wizard?.open()"><Icon name="plus" />New job</button>
      </div>
    </header>

    <div v-if="loadError" class="form-error" role="alert">
      <Icon name="alert" />{{ loadError }} <button class="btn btn-sm" @click="load">Retry</button>
    </div>

    <section v-else-if="jobs && !jobs.length" class="panel empty">
      <Icon name="jobs" :size="28" />
      <h2>No jobs yet</h2>
      <p>A job holds the role, its application form and the workflow each candidate goes through. Publish it and share the apply link.</p>
      <button class="btn btn-primary" data-tour="new-job" @click="wizard?.open()"><Icon name="plus" />New job</button>
    </section>

    <template v-else>
      <div class="seg" role="radiogroup" aria-label="Show jobs" :inert="!jobs">
        <label v-for="f in FILTERS" :key="f.value">
          <input type="radio" name="status" :value="f.value" :checked="filter === f.value" @change="setFilter(f.value)">
          <span>{{ f.label }} <b v-if="jobs" class="n">{{ count(f.value) }}</b></span>
        </label>
      </div>

      <div class="panel table-wrap" :aria-busy="!jobs">
        <table class="table">
          <thead>
            <tr><th>Job</th><th>Status</th><th>Candidates</th><th class="num">Hired</th><th>Closes</th><th>Owner</th><th><span class="sr-only">Apply link</span></th></tr>
          </thead>
          <tbody>
            <template v-if="!jobs">
              <tr v-for="i in 6" :key="i"><td v-for="(w, k) in [70, 50, 40, 30, 40, 60]" :key="k" :class="{ num: k === 3 }"><span class="skeleton sk" :style="{ width: `${w}%` }" /></td><td /></tr>
            </template>
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
            <tr v-if="jobs && !shown.length">
              <td colspan="7" class="none">No {{ FILTERS.find(f => f.value === filter)!.label.toLowerCase() }} jobs.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <JobNewJobWizard ref="wizard" :jobs="copyable" />
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
.sk { display: block; height: 14px; margin: 4px 0; }
.num .sk { margin-left: auto; }
.form-error .btn { margin-left: auto; }
.cands { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cand-n { color: var(--ink); text-decoration: none; font-variant-numeric: tabular-nums; }
.cand-n:hover { text-decoration: underline; }
.cands .chip { text-decoration: none; }
.link-cell { width: 1%; white-space: nowrap; text-align: right; padding-block: 0; }
</style>
