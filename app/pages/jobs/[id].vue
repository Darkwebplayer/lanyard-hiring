<script lang="ts">
import type { Ref } from 'vue'
import type { Stage } from '~~/shared/workflow/types'
export interface PipelineRow {
  id: string, status: 'active' | 'closed', outcome: string | null, currentNodeKey: string | null, createdAt: string
  version: number, runStatus: string | null, candidate: { firstName: string, lastName: string, email: string }
  dueAt: string | null, assignees: { id: string, name: string, submitted: boolean }[]
  total: number // how many matched the query, before paging
}
// Counts only: where everyone is, never the rows, so the tab holds up at thousands of applicants.
export interface Board {
  stages: Stage[] | null
  steps: { key: string, type: string, label?: string }[]
  counts: { key: string | null, status: 'active' | 'closed', outcome: string | null, n: number, failed: number, overdue: number }[]
  preview: PipelineRow[] // the first five of each group, in list order
}
export interface PipelineState { board: Ref<Board | null>, error: Ref<string | null>, load: () => Promise<void> }
</script>

<script setup lang="ts">
import type { Issue } from '~~/shared/workflow/types'
import { issueText } from '~/lib/flow'
import type { JobStatus } from '~/composables/useJob'

const route = useRoute()
const router = useRouter()
const id = route.params.id as string
const { detail, error, refresh } = useJob(id)
const job = computed(() => detail.value?.job)
useHead({ title: () => job.value?.title ?? 'Job' })

// The board counts live here so the tab can show its count; the pipeline tab reads them via inject.
const board = ref<Board | null>(null)
const boardError = ref<string | null>(null)
async function loadBoard() {
  boardError.value = null
  try { board.value = await api<Board>(`/api/jobs/${id}/board`) }
  catch (e) { boardError.value = toApiError(e).message }
}
provide<PipelineState>('pipeline', { board, error: boardError, load: loadBoard })

onMounted(() => {
  // a different job's state may be cached from an earlier visit; refresh either way
  refresh()
  loadBoard()
})

const archived = computed(() => job.value?.status === 'archived')
const notFound = computed(() => error.value?.status === 404)
const draft = computed(() => detail.value?.draft)
const published = computed(() => detail.value?.published)
const versionLine = computed(() => {
  if (!published.value) return 'Draft, never published'
  const v = `v${published.value.version} ${job.value?.status === 'open' ? 'live' : 'published'}`
  return draft.value ? `${v} · unpublished changes` : v
})

const base = `/jobs/${id}`
const tabs = computed(() => [
  { to: base, label: 'Pipeline', count: board.value?.counts.reduce((n, c) => n + c.n, 0) },
  { to: `${base}/flow`, label: 'Flow' },
  { to: `${base}/form`, label: 'Form' },
  { to: `${base}/details`, label: 'Details' },
])
const isFlow = computed(() => route.path.startsWith(`${base}/flow`))

// ---- publish ----
type Panel = { kind: 'issues', issues: Issue[] } | { kind: 'done', version: number } | null
const panel = ref<Panel>(null)
const confirmDlg = ref<HTMLDialogElement>()
const checking = ref(false)
const publishing = ref(false)
const publishError = ref<string | null>(null)

// Runs the publish checks and shows what blocks; null if the check itself failed.
async function check() {
  checking.value = true
  publishError.value = null
  try {
    const { issues } = await api<{ issues: Issue[] }>(`/api/jobs/${id}/validate`, { method: 'POST' })
    panel.value = issues.length ? { kind: 'issues', issues } : null
    return issues
  }
  catch (e) {
    publishError.value = toApiError(e).message
    return null
  }
  finally { checking.value = false }
}
async function startPublish() {
  const issues = await check()
  if (issues && !issues.length) confirmDlg.value?.showModal()
}
// ?check=1: a preset was just loaded (new job or replaced draft), so show what it left to fix, on any tab.
watch(() => route.query.check, async (c) => {
  if (!c) return
  await check()
  router.replace({ query: { ...route.query, check: undefined } })
}, { immediate: true })
// people and earlier versions are only checked once the flow itself is sound (versionIssues)
const LATE = new Set(['bad_assignee', 'bad_role', 'not_enough_assignees', 'node_type_changed', 'field_type_changed'])
const moreLater = computed(() => panel.value?.kind === 'issues' && panel.value.issues.some(i => !LATE.has(i.code)))
async function publish() {
  publishing.value = true
  publishError.value = null
  try {
    const v = await api<{ version: number }>(`/api/jobs/${id}/publish`, { method: 'POST' })
    confirmDlg.value?.close()
    panel.value = { kind: 'done', version: v.version }
    await refresh()
  }
  catch (e) {
    const err = toApiError(e)
    confirmDlg.value?.close()
    if (err.issues.length) panel.value = { kind: 'issues', issues: err.issues }
    else publishError.value = err.message
  }
  finally { publishing.value = false }
}

// The server names people, roles and keys as data; say what to do instead (these come up after loading a preset).
const ASSIGNEE_TEXT: Record<string, string> = {
  bad_assignee: 'Assigned to someone who can’t sign in any more. Pick someone else, or the job owner.',
  bad_role: 'Assigned to a role that was deleted. Pick another role.',
}
function assigneeText(i: Issue) {
  const [need, have] = i.code === 'not_enough_assignees' ? i.message.match(/\d+/g) ?? [] : []
  if (need) return `Needs ${plural(+need, 'scorecard')}, but only ${plural(+(have ?? 0), 'person', 'people')} can be assigned. Add people or a role.`
  const changed = i.code.endsWith('_type_changed') && /^(\S+) was (\w+) in an earlier version; use a new key for a (\w+)$/.exec(i.message)
  if (changed) return `“${changed[1]!.split('.').at(-1)}” was ${changed[2]} in an earlier version. Give the ${changed[3]} a new key.`
  return ASSIGNEE_TEXT[i.code]
}
// Issues grouped by the step or field they belong to, each linking to where it's fixed.
const FORM_CODES = new Set(['invalid_form', 'duplicate_field', 'enum_without_options', 'min_gt_max', 'field_type_changed'])
const issueGroups = computed(() => {
  if (panel.value?.kind !== 'issues') return []
  const nodes = (draft.value ?? published.value)?.workflow.nodes ?? []
  const groups = new Map<string, { title: string, key?: string, to: string, items: string[] }>()
  for (const i of panel.value.issues) {
    let g: { id: string, title: string, key?: string, to: string }
    if (i.node) {
      const n = nodes.find(n => n.key === i.node)
      g = { id: `n:${i.node}`, title: n ? nodeLabel(n) : i.node, key: i.node, to: `${base}/flow?node=${i.node}` }
    }
    else if (FORM_CODES.has(i.code) || i.message.startsWith('form')) g = { id: 'form', title: 'Application form', to: `${base}/form` }
    else g = { id: 'flow', title: 'The flow as a whole', to: `${base}/flow` }
    if (!groups.has(g.id)) groups.set(g.id, { ...g, items: [] })
    groups.get(g.id)!.items.push(assigneeText(i) ?? issueText(i, { nodes, edges: [] }))
  }
  return [...groups.values()]
})

// ---- status ----
const statusError = ref<string | null>(null)
const archiveDlg = ref<HTMLDialogElement>()
const menu = ref<HTMLElement>()
const changing = ref(false)
async function setStatus(status: JobStatus) {
  menu.value?.hidePopover()
  changing.value = true
  statusError.value = null
  try {
    const updated = await api<NonNullable<typeof job.value>>(`/api/jobs/${id}`, { method: 'PATCH', body: { status } })
    if (detail.value) detail.value = { ...detail.value, job: updated }
    archiveDlg.value?.close()
  }
  catch (e) {
    archiveDlg.value?.close()
    statusError.value = toApiError(e).message
  }
  finally { changing.value = false }
}
function askArchive() {
  menu.value?.hidePopover()
  archiveDlg.value?.showModal()
}
</script>

<template>
  <div class="page" :class="{ wide: isFlow }">
    <NuxtLink to="/jobs" class="crumb"><Icon name="chevron-left" :size="14" />Jobs</NuxtLink>

    <section v-if="notFound" class="panel empty">
      <h1>This job doesn’t exist</h1>
      <p>It may have been removed, or the link is wrong.</p>
      <NuxtLink to="/jobs" class="btn">Back to jobs</NuxtLink>
    </section>

    <div v-else-if="error && !detail" class="form-error" role="alert">
      <Icon name="alert" />{{ error.message }} <button class="btn btn-sm" @click="refresh">Retry</button>
    </div>

    <template v-else>
      <header class="page-head">
        <div v-if="job" class="head">
          <h1>{{ job.title }}</h1>
          <p class="sub"><JobStatusChip :status="job.status" /><span>{{ versionLine }}</span></p>
        </div>
        <div v-else class="head" aria-busy="true">
          <span class="skeleton" style="display:block;width:320px;height:30px" />
          <span class="skeleton" style="display:block;width:180px;height:16px;margin-top:10px" />
        </div>

        <div v-if="job && !archived" class="actions">
          <JobApplyActions v-if="job.status === 'open'" :job-id="id" />
          <button class="btn status-btn" popovertarget="job-status-menu" :aria-busy="changing">
            <span v-if="changing" class="spinner" />Status<Icon name="chevron-down" />
          </button>
          <div id="job-status-menu" ref="menu" popover class="menu status-menu">
            <button v-if="job.status === 'closed'" @click="setStatus('open')"><Icon name="reopen" />Open applications</button>
            <button v-if="job.status === 'open'" @click="setStatus('closed')"><Icon name="stop" />Close applications</button>
            <hr v-if="job.status !== 'draft'">
            <button class="danger" @click="askArchive"><Icon name="trash" />Archive job…</button>
          </div>
          <button v-if="draft" class="btn btn-primary" :aria-busy="checking" :disabled="checking" @click="startPublish">
            <span v-if="checking" class="spinner" />Publish v{{ draft.version }}
          </button>
        </div>
      </header>

      <div aria-live="polite">
        <p v-if="statusError || publishError" class="form-error" role="alert"><Icon name="alert" />{{ statusError || publishError }}</p>

        <section v-if="panel?.kind === 'issues'" class="panel result" data-slot="bad" aria-labelledby="issues-h">
          <div class="result-head">
            <h2 id="issues-h">Fix {{ plural(panel.issues.length, 'thing') }} before publishing</h2>
            <button class="btn btn-icon btn-sm btn-quiet" aria-label="Hide" @click="panel = null"><Icon name="x" /></button>
          </div>
          <ul class="groups">
            <li v-for="g in issueGroups" :key="g.title + g.key">
              <NuxtLink :to="g.to" class="group-link">{{ g.title }}<code v-if="g.key">{{ g.key }}</code><Icon name="arrow-right" :size="14" /></NuxtLink>
              <ul><li v-for="(m, i) in g.items" :key="i">{{ m }}</li></ul>
            </li>
          </ul>
          <p v-if="moreLater" class="faint later">Assignees and earlier versions are checked once these are fixed.</p>
        </section>

        <section v-else-if="panel?.kind === 'done'" class="panel result done" aria-labelledby="done-h">
          <div class="result-head">
            <h2 id="done-h">v{{ panel.version }} is {{ job?.status === 'open' ? 'live' : 'published' }}</h2>
            <button class="btn btn-icon btn-sm btn-quiet" aria-label="Hide" @click="panel = null"><Icon name="x" /></button>
          </div>
          <template v-if="job?.status === 'open'">
            <p class="muted">New applications go through v{{ panel.version }}. Share the apply link:</p>
            <JobCopyLink :job-id="id" />
          </template>
          <p v-else class="muted">The job is closed, so nobody can apply. Open applications from Status when you’re ready.</p>
        </section>
      </div>

      <nav class="tabs" aria-label="Job">
        <NuxtLink v-for="t in tabs" :key="t.to" :to="t.to" :aria-current="route.path === t.to ? 'page' : undefined">
          {{ t.label }}<span v-if="t.count !== undefined" class="tab-n">{{ t.count }}</span>
        </NuxtLink>
      </nav>

      <p v-if="archived" class="banner"><Icon name="lock" :size="16" />This job is archived. It’s kept for the record and can’t be changed.</p>

      <div class="tab-body">
        <NuxtPage />
      </div>
    </template>

    <dialog ref="confirmDlg" class="dialog" aria-labelledby="pub-h" @click.self="confirmDlg?.close()">
      <div class="dialog-body">
        <h2 id="pub-h">Publish v{{ draft?.version }}?</h2>
        <p v-if="published">Candidates who already applied stay on v{{ published.version }}. New applications use v{{ draft?.version }}.</p>
        <p v-else-if="job?.status === 'draft'">The job goes live and starts taking applications at its apply link.</p>
      </div>
      <div class="dialog-foot">
        <button class="btn btn-quiet" @click="confirmDlg?.close()">Cancel</button>
        <button class="btn btn-primary" :aria-busy="publishing" :disabled="publishing" @click="publish"><span v-if="publishing" class="spinner" />Publish v{{ draft?.version }}</button>
      </div>
    </dialog>

    <dialog ref="archiveDlg" class="dialog" aria-labelledby="arch-h" @click.self="archiveDlg?.close()">
      <div class="dialog-body">
        <h2 id="arch-h">Archive “{{ job?.title }}”?</h2>
        <p>It stops taking applications, and its form, flow and details can’t be changed again. This can’t be undone.</p>
      </div>
      <div class="dialog-foot">
        <button class="btn btn-quiet" @click="archiveDlg?.close()">Cancel</button>
        <button class="btn btn-danger" :aria-busy="changing" :disabled="changing" @click="setStatus('archived')">Archive job</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.page.wide { max-width: none; }
.empty h1 { color: var(--ink); }
.page-head { margin-bottom: 16px; }
.head { min-width: 0; flex: 1 1 420px; }
.head h1 { overflow-wrap: anywhere; }
.sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.actions { align-items: center; }
.status-btn { anchor-name: --job-status; }
.status-menu { position-anchor: --job-status; inset: auto; top: anchor(bottom); right: anchor(right); margin-top: 6px; }
.menu .danger { color: var(--bad); }
.result { position: relative; padding: 24px 20px 18px; margin-bottom: 16px; display: grid; gap: 12px; }
.result-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.result h2 { font-size: var(--t-lg); }
.done h2 { font-size: var(--t-xl); }
.done .copy-link { max-width: 560px; }
.groups { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.group-link { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; text-decoration: none; color: var(--ink); }
.group-link:hover { color: var(--accent-ink); }
.group-link code { color: var(--ink-3); font-weight: 400; }
.groups ul { margin: 4px 0 0; padding-left: 20px; color: var(--ink-2); }
.later { font-size: var(--t-sm); }
.form-error { margin-bottom: 16px; }
.form-error .btn { margin-left: auto; }
.tab-n { min-width: 20px; padding: 0 6px; border-radius: var(--r-pill); background: var(--sunk); font-size: var(--t-xs); line-height: 20px; text-align: center; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.banner { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding: 10px 14px; border-radius: var(--r-panel); background: var(--sunk); color: var(--ink-2); font-weight: 500; }
.tab-body { padding-top: 20px; }
</style>
