<script setup lang="ts">
useHead({ title: 'Hires' })

interface Row { id: string, title: string, status: 'draft' | 'open' | 'closed' | 'archived', openings: number, applications: number, hired: number, fillRate: number }
interface Hire {
  id: string, firstName: string, lastName: string, jobId: string, jobTitle: string, hiredAt: string, startDate: string | null
  how: 'link' | 'phone' | 'email' | 'in_person' | 'hand' | 'flow', documents: { received: number, required: number } | null
}
interface Report {
  jobs: Row[], totals: { jobs: number, openings: number, hires: number, fillRate: number }, bySource?: { source: string | null, applied: number, hired: number }[]
  hired?: Hire[]
}

const report = ref<Report | null>(null)
const error = ref('')
async function load() {
  error.value = ''
  try { report.value = await api<Report>('/api/reports/hires') }
  catch (e) { error.value = toApiError(e).message }
}
load()

const open = (j: Row) => Math.max(j.openings - j.hired, 0)
// Live jobs first, then the most open seats: that's where hiring work is left.
const rows = computed(() => [...report.value?.jobs ?? []].sort((a, b) =>
  Number(b.status === 'open') - Number(a.status === 'open') || open(b) - open(a) || a.title.localeCompare(b.title)))

// The headline counts live jobs; with none live it falls back to every published job.
const head = computed(() => {
  const jobs = report.value?.jobs ?? []
  const live = jobs.filter(j => j.status === 'open')
  const set = live.length ? live : jobs
  const openings = set.reduce((s, j) => s + j.openings, 0)
  const hires = set.reduce((s, j) => s + j.hired, 0)
  return { live: live.length > 0, openings, hires, rate: openings ? hires / openings : 0 }
})
// Where hires came from: most hires first, then most applications; the bar shares one scale (the busiest source).
const sources = computed(() => [...report.value?.bySource ?? []].sort((a, b) => b.hired - a.hired || b.applied - a.applied))
const mostApplied = computed(() => Math.max(1, ...sources.value.map(s => s.applied)))
const HOW: Record<Hire['how'], string> = {
  link: 'signed on link', phone: 'recorded by phone', email: 'recorded by email', in_person: 'recorded in person', hand: 'moved by hand', flow: 'by the flow',
}
const starts = (d: string | null) => !d ? 'Not set' : /^\d{4}-\d{2}-\d{2}$/.test(d) ? fmtDate(`${d}T00:00`) : d
const docsText = (d: Hire['documents']) => !d ? 'No step' : d.received >= d.required ? 'All in' : `${d.received} of ${d.required}`
const applications = computed(() => (report.value?.jobs ?? []).reduce((s, j) => s + j.applications, 0))

</script>

<template>
  <div class="page">
    <header class="page-head"><h1>Hires</h1></header>

    <div v-if="error" class="empty" role="alert">
      <h2>The report didn’t load</h2>
      <p>{{ error }}</p>
      <button class="btn" @click="load"><Icon name="retry" />Try again</button>
    </div>

    <template v-else-if="!report">
      <div class="stats">
        <div class="skeleton" style="height: 132px; border-radius: var(--r-card)" />
        <div class="skeleton" style="height: 132px; border-radius: var(--r-panel)" />
        <div class="skeleton" style="height: 132px; border-radius: var(--r-panel)" />
      </div>
      <div class="panel table-wrap" aria-busy="true" aria-label="Loading the report">
        <table class="table">
          <thead>
            <tr><th>Job</th><th>Status</th><th class="num">Applications</th><th>Seats</th><th class="num">Fill rate</th></tr>
          </thead>
          <tbody>
            <tr v-for="i in 5" :key="i"><td v-for="(w, k) in [70, 40, 30, 50, 30]" :key="k" :class="{ num: k === 2 || k === 4 }"><span class="skeleton sk" :style="{ width: `${w}%` }" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else-if="!report.jobs.length" class="empty">
      <Icon name="hires" :size="28" />
      <h2>No published jobs yet</h2>
      <p>Seats filled and fill rates show here once a job has been published.</p>
      <NuxtLink to="/jobs" class="btn">Go to Jobs</NuxtLink>
    </div>

    <template v-else>
      <section class="stats" aria-label="Totals">
        <div class="card headline">
          <p class="big"><b>{{ head.hires }}</b> of {{ head.openings }} <span>seats filled</span></p>
          <p class="muted">{{ pct(head.rate) }} fill rate across {{ head.live ? 'live jobs' : 'every published job' }}</p>
        </div>
        <div class="panel quiet">
          <p class="n">{{ report.totals.jobs }}</p>
          <p class="muted">{{ report.totals.jobs === 1 ? 'job' : 'jobs' }} published, {{ report.jobs.filter(j => j.status === 'open').length }} live</p>
        </div>
        <div class="panel quiet">
          <p class="n">{{ applications.toLocaleString() }}</p>
          <p class="muted">applications, all time</p>
        </div>
      </section>

      <section class="panel table-wrap" aria-labelledby="by-job">
        <h2 id="by-job" class="sr-only">By job</h2>
        <table class="table">
          <thead>
            <tr><th>Job</th><th>Status</th><th class="num">Applications</th><th>Seats</th><th class="num">Fill rate</th></tr>
          </thead>
          <tbody>
            <tr v-for="j in rows" :key="j.id">
              <td class="title"><NuxtLink :to="`/jobs/${j.id}`" class="row-link">{{ j.title }}</NuxtLink></td>
              <td><JobStatusChip :status="j.status" /></td>
              <td class="num">{{ j.applications.toLocaleString() }}</td>
              <td>
                <div class="seats">
                  <span v-if="Math.max(j.openings, j.hired) <= 12" class="pills" aria-hidden="true">
                    <i v-for="n in Math.max(j.openings, j.hired)" :key="n" :class="{ on: n <= j.hired }" />
                  </span>
                  <span v-else class="bar" aria-hidden="true"><i :style="{ width: pct(Math.min(j.fillRate, 1)) }" /></span>
                  <span class="seat-text">{{ j.hired }} of {{ j.openings }}<span v-if="open(j)" class="faint">, {{ open(j) }} open</span></span>
                </div>
              </td>
              <td class="num">{{ pct(j.fillRate) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="sources.length" class="panel table-wrap src" aria-labelledby="by-src">
        <header class="src-head">
          <h2 id="by-src">Where hires came from</h2>
          <p class="muted">From the tag on each apply link, across every job. Links without a tag show as “No source tag”.</p>
        </header>
        <table class="table">
          <thead>
            <tr><th>Source</th><th><span class="sr-only">Share hired</span></th><th class="num">Applications</th><th class="num">Hired</th><th class="num">Hire rate</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in sources" :key="s.source ?? ''">
              <td class="title" :class="{ faint: s.source === null }">{{ sourceLabel(s.source, 'No source tag') }}</td>
              <td>
                <span class="sbar" aria-hidden="true">
                  <i class="applied" :style="{ width: pct(s.applied / mostApplied) }"><i class="hired" :style="{ width: pct(s.applied ? s.hired / s.applied : 0) }" /></i>
                </span>
              </td>
              <td class="num">{{ s.applied.toLocaleString() }}</td>
              <td class="num"><b v-if="s.hired">{{ s.hired }}</b><span v-else class="faint">0</span></td>
              <td class="num">{{ s.applied ? pct(s.hired / s.applied) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="report.hired?.length" class="panel table-wrap src" aria-labelledby="who">
        <header class="src-head">
          <h2 id="who">Who was hired</h2>
          <p class="muted">Last 90 days. The start date comes from their accepted offer.</p>
        </header>
        <table class="table">
          <thead>
            <tr><th>Name</th><th>Job</th><th>Starts</th><th>Documents</th><th>Hired</th></tr>
          </thead>
          <tbody>
            <tr v-for="h in report.hired" :key="h.id">
              <td class="title"><NuxtLink :to="`/candidates/${h.id}`" class="row-link">{{ fullName(h) }}</NuxtLink></td>
              <td><NuxtLink :to="`/jobs/${h.jobId}`">{{ h.jobTitle }}</NuxtLink></td>
              <td :class="{ faint: !h.startDate }">{{ starts(h.startDate) }}</td>
              <td :class="{ faint: !h.documents }">{{ docsText(h.documents) }}</td>
              <td>{{ fmtDate(h.hiredAt) }} <span class="faint">· {{ HOW[h.how] }}</span></td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.sk { display: block; height: 14px; margin: 4px 0; }
.num .sk { margin-left: auto; }
.stats { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-bottom: 24px; align-items: stretch; }
.headline { padding: 32px 28px 24px; display: grid; gap: 6px; align-content: end; }
.big { font-size: var(--t-xl); font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.big b { font-size: var(--t-3xl); font-weight: 700; color: var(--ink); letter-spacing: -0.03em; }
.big span { color: var(--ink); font-weight: 600; }
.quiet { padding: 20px; display: grid; gap: 2px; align-content: end; }
.quiet .n { font-size: var(--t-xl); font-weight: 600; font-variant-numeric: tabular-nums; }
.quiet .muted { font-size: var(--t-sm); }
.title { min-width: 160px; }
.seats { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
.pills { display: inline-flex; gap: 3px; }
.pills i { width: 12px; height: 6px; border-radius: 9px; box-shadow: inset 0 0 0 1.5px var(--line-2); }
.pills i.on { background: var(--ok); box-shadow: none; }
.bar { width: 177px; height: 6px; border-radius: 9px; background: var(--sunk); box-shadow: inset 0 0 0 1px var(--line-2); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--ok); border-radius: 9px; }
.seat-text { font-size: var(--t-sm); }
.src { margin-top: 24px; }
.src-head { padding: 20px 20px 4px; display: grid; gap: 4px; }
.src-head h2 { font-size: var(--t-lg); }
.src-head .muted { font-size: var(--t-sm); }
/* one bar per source: its length is applications (against the busiest source), the green inside is the share hired,
   so a small source that hires well still shows its green */
.sbar { display: block; width: 177px; height: 6px; }
.sbar .applied { display: block; height: 100%; min-width: 6px; border-radius: 9px; background: var(--sunk); box-shadow: inset 0 0 0 1px var(--line-2); overflow: hidden; }
.sbar .hired { display: block; height: 100%; background: var(--ok); border-radius: 9px; }
</style>
