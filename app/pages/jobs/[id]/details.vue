<script setup lang="ts">
import { jobFieldsRead } from '~~/shared/workflow/flowPresets'
import type { Requirements } from '~~/shared/workflow/job'
import type { Job } from '~/composables/useJob'

const route = useRoute()
const id = route.params.id as string
const { detail, editable } = useJob(id)
const { me } = useMe()
const job = computed(() => detail.value?.job)
const archived = computed(() => job.value?.status === 'archived')

// Dates travel as ISO; the date input wants the local YYYY-MM-DD.
const toDay = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fromJob(j: Job) {
  const r = j.requirements ?? {}
  return {
    title: j.title, description: j.description, openings: j.openings as number | '', closesAt: toDay(j.closesAt), ownerId: j.ownerId,
    minYears: (r.min_experience_years ?? '') as number | '', skills: [...(r.must_have_skills ?? [])],
    salaryMin: (r.salary_min ?? '') as number | '', salaryMax: (r.salary_max ?? '') as number | '',
    location: r.location ?? '', employmentType: r.employment_type ?? '',
    workplace: (r.workplace_type ?? '') as '' | 'on_site' | 'hybrid' | 'remote',
    currency: r.salary_currency ?? 'EUR', showSalary: !!r.show_salary,
  }
}
type Draft = ReturnType<typeof fromJob>
const form = ref<Draft | null>(null)
const original = ref<Draft | null>(null)
// until the job arrives a blank, busy form stands in, so headings and labels show from the start
const fields = computed(() => form.value ?? fromJob({ title: '', description: '', openings: '', closesAt: null, ownerId: '' } as never))
watch(job, (j) => {
  // don't throw away someone's typing when the hub refreshes
  if (j && (!form.value || !dirty.value)) {
    form.value = fromJob(j)
    original.value = fromJob(j)
  }
}, { immediate: true })

function requirementsOf(f: Draft): Requirements {
  const r: Requirements = {}
  if (f.minYears !== '') r.min_experience_years = f.minYears
  if (f.skills.length) r.must_have_skills = f.skills
  if (f.salaryMin !== '') r.salary_min = f.salaryMin
  if (f.salaryMax !== '') r.salary_max = f.salaryMax
  if (f.location.trim()) r.location = f.location.trim()
  if (f.employmentType.trim()) r.employment_type = f.employmentType.trim()
  if (f.workplace) r.workplace_type = f.workplace
  if (f.salaryMin !== '' || f.salaryMax !== '') r.salary_currency = f.currency.trim().toUpperCase() || 'EUR'
  if (f.showSalary) r.show_salary = true
  return r
}

const WORKPLACES = [
  { value: '', label: 'Not set' },
  { value: 'on_site', label: 'On-site' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'remote', label: 'Remote' },
] as const

// Only what changed goes to the server; requirements are one object, so they go whole.
const patch = computed(() => {
  const f = form.value, o = original.value
  if (!f || !o) return {}
  const p: Record<string, unknown> = {}
  if (f.title.trim() !== o.title) p.title = f.title.trim()
  if (f.description !== o.description) p.description = f.description
  if (f.openings !== o.openings) p.openings = f.openings
  if (f.closesAt !== o.closesAt) p.closesAt = f.closesAt ? new Date(`${f.closesAt}T23:59:59`).toISOString() : null
  if (f.ownerId !== o.ownerId) p.ownerId = f.ownerId
  if (JSON.stringify(requirementsOf(f)) !== JSON.stringify(requirementsOf(o))) p.requirements = requirementsOf(f)
  return p
})
const dirty = computed(() => Object.keys(patch.value).length > 0)
const salaryError = computed(() => {
  const f = form.value
  return f && f.salaryMin !== '' && f.salaryMax !== '' && f.salaryMin > f.salaryMax ? 'The minimum is higher than the maximum.' : null
})

const saving = ref(false)
const saved = ref(false)
const saveError = ref<string | null>(null)
async function save() {
  if (!dirty.value || salaryError.value) return
  saving.value = true
  saveError.value = null
  try {
    const updated = await api<Job>(`/api/jobs/${id}`, { method: 'PATCH', body: patch.value })
    if (detail.value) detail.value = { ...detail.value, job: updated }
    form.value = fromJob(updated)
    original.value = fromJob(updated)
    saved.value = true
    setTimeout(() => (saved.value = false), 2500)
  }
  catch (e) { saveError.value = toApiError(e).message }
  finally { saving.value = false }
}
watch(form, () => { saved.value = false }, { deep: true })
onBeforeRouteLeave(() => !dirty.value || confirm('Leave without saving your changes?'))

// ---- requirements the flow reads that this job leaves empty (a flow from a preset or another job brings its own) ----
const emptyRead = computed(() => {
  const f = form.value
  const wf = editable.value?.workflow
  if (!f || !wf) return []
  const empty: Record<string, boolean> = {
    'job.min_experience_years': f.minYears === '', 'job.must_have_skills': !f.skills.length,
    'job.salary_min': f.salaryMin === '', 'job.salary_max': f.salaryMax === '',
    'job.location': !f.location.trim(), 'job.employment_type': !f.employmentType.trim(),
  }
  return jobFieldsRead(wf).filter(x => empty[x.path])
})
// AI review sends the requirements with the CV, so empty skills or years weaken its score
const aiReads = computed(() => editable.value?.workflow.nodes.some(n => n.type === 'ai_review' || n.type === 'ai_check')
  ? emptyRead.value.filter(x => x.path === 'job.must_have_skills' || x.path === 'job.min_experience_years').map(x => x.label)
  : [])
const listOf = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`

// ---- owner: any manager or admin who can sign in ----
interface UserRow { id: string, name: string, roleLevel: string | null }
const owners = ref<UserRow[]>([])
const ownerName = ref<string | null>(null)
onMounted(async () => {
  try {
    const users = await api<UserRow[]>('/api/users/assignable')
    owners.value = users.filter(u => u.roleLevel === 'admin' || u.roleLevel === 'manager')
    ownerName.value = users.find(u => u.id === detail.value?.job.ownerId)?.name ?? null
  }
  catch { /* the owner line falls back below */ }
})
const ownerLabel = computed(() => job.value?.ownerId === me.value?.id ? `${me.value?.name} (you)` : ownerName.value ?? 'Someone on the team')
</script>

<template>
  <form class="grid" :aria-busy="!form" :inert="!form" @submit.prevent="save">
    <fieldset :disabled="archived" class="cols">
      <section class="panel block">
        <h2>About the job</h2>
        <div class="field">
          <label for="d-title">Title</label>
          <input id="d-title" v-model="fields.title" required maxlength="200">
        </div>
        <div class="field">
          <label for="d-desc">Description</label>
          <JobMarkdownEditor id="d-desc" v-model="fields.description" :maxlength="20000" :disabled="archived" />
          <span class="hint">Candidates read this on the apply page, formatted as in Preview.</span>
        </div>
        <div class="row">
          <div class="field">
            <label for="d-open">Openings</label>
            <input id="d-open" v-model.number="fields.openings" type="number" min="1" max="10000" required>
          </div>
          <div class="field">
            <label for="d-close">Closes on</label>
            <input id="d-close" v-model="fields.closesAt" type="date">
            <span class="hint">Leave empty to keep it open.</span>
          </div>
        </div>
        <div class="field">
          <label for="d-owner">Owner</label>
          <select v-if="owners.length" id="d-owner" v-model="fields.ownerId">
            <option v-for="u in owners" :key="u.id" :value="u.id">{{ u.name }}{{ u.id === me?.id ? ' (you)' : '' }}</option>
          </select>
          <span v-else-if="!form" class="skeleton" style="display: block; height: var(--h-md)" />
          <p v-else id="d-owner" class="readonly"><Avatar :name="ownerLabel" :size="24" />{{ ownerLabel }}</p>
          <span class="hint">Gets the steps assigned to “job owner”.</span>
        </div>
      </section>

      <section class="panel block">
        <div>
          <div class="req-head">
            <h2>Requirements</h2>
            <button type="button" class="btn btn-sm btn-quiet" @click="useHelp().show('ai')">What does the AI read?</button>
          </div>
          <p class="muted note">Changes reach the flow when you next publish.</p>
        </div>
        <p v-if="emptyRead.length && !archived" class="reads" role="status">
          <Icon name="alert" :size="16" />
          <span>Your flow reads {{ listOf(emptyRead.map(x => x.label)) }}, which {{ emptyRead.length === 1 ? 'is' : 'are' }} empty here.<template v-if="aiReads.length"> AI review scores the CV against {{ listOf(aiReads) }}.</template></span>
        </p>
        <div class="row">
          <div class="field">
            <label for="d-years">Minimum years of experience</label>
            <input id="d-years" v-model.number="fields.minYears" type="number" min="0" max="60" step="0.5">
          </div>
          <div class="field">
            <label for="d-type">Employment type</label>
            <input id="d-type" v-model="fields.employmentType" list="emp-types" maxlength="50" placeholder="e.g. Full-time">
            <datalist id="emp-types"><option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option><option>Temporary</option></datalist>
          </div>
        </div>
        <div class="field">
          <label for="d-skill">Must-have skills</label>
          <JobSkillsInput id="d-skill" v-model="fields.skills" placeholder="Figma, user research, …" />
          <span class="hint">Press Enter or comma after each. Paste a comma list to add several.</span>
        </div>
        <div class="field">
          <span class="label">Salary range</span>
          <div class="row salary">
            <input v-model.number="fields.salaryMin" type="number" min="0" aria-label="Salary minimum" placeholder="Min" :aria-invalid="!!salaryError">
            <input v-model.number="fields.salaryMax" type="number" min="0" aria-label="Salary maximum" placeholder="Max" :aria-invalid="!!salaryError">
            <input v-model="fields.currency" class="cur" maxlength="3" aria-label="Currency, three letters" placeholder="EUR" autocapitalize="characters" spellcheck="false">
          </div>
          <span v-if="salaryError" class="error"><Icon name="alert" :size="14" />{{ salaryError }}</span>
          <label class="check"><input v-model="fields.showSalary" type="checkbox" :disabled="fields.salaryMin === '' && fields.salaryMax === ''">Show the salary on the apply page</label>
          <span class="hint"><Icon :name="fields.showSalary ? 'external' : 'eye-off'" :size="13" />{{ fields.showSalary ? 'Candidates see this range from the next publish.' : 'Only your team sees it.' }}</span>
        </div>
        <div class="field">
          <span id="d-work" class="label">Workplace</span>
          <div class="seg" role="radiogroup" aria-labelledby="d-work">
            <label v-for="w in WORKPLACES" :key="w.value"><input v-model="fields.workplace" type="radio" name="workplace" :value="w.value"><span>{{ w.label }}</span></label>
          </div>
        </div>
        <div class="field">
          <label for="d-loc">Location</label>
          <input id="d-loc" v-model="fields.location" maxlength="200" placeholder="e.g. Berlin or Remote (EU)">
        </div>
      </section>
    </fieldset>

    <div v-if="!archived" class="foot">
      <p v-if="saveError" class="form-error" role="alert"><Icon name="alert" />{{ saveError }}</p>
      <span class="status" aria-live="polite">
        <template v-if="saved"><Icon name="check" :size="14" />Saved</template>
        <template v-else-if="dirty">Unsaved changes</template>
      </span>
      <button class="btn btn-dark" :disabled="!dirty || saving || !!salaryError" :aria-busy="saving"><span v-if="saving" class="spinner" />Save changes</button>
    </div>
  </form>
</template>

<style scoped>
.grid { display: grid; gap: 16px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; align-items: start; }
.block { padding: 20px; display: grid; gap: 18px; }
.block h2 { font-size: var(--t-lg); }
.req-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-block: -4px; }
.note { margin-top: 4px; font-size: var(--t-sm); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.hint { display: inline-flex; align-items: center; gap: 6px; }
.readonly { display: flex; align-items: center; gap: 8px; min-height: var(--h-md); font-weight: 500; }
.foot { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 12px 0; background: var(--bg); flex-wrap: wrap; }
.foot .form-error { margin-right: auto; }
.status { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); font-size: var(--t-sm); font-weight: 500; }
.reads { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: var(--r-field); background: var(--warn-tint); color: var(--ink); font-size: var(--t-sm); text-wrap: pretty; }
.reads svg { flex: none; margin-top: 1px; color: var(--warn); }
.salary { grid-template-columns: 1fr 1fr 88px; }
.cur { text-transform: uppercase; font-family: var(--mono); }
</style>
