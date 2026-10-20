<script setup lang="ts">
useHead({ title: 'Hires' })

interface Row { id: string, title: string, status: 'draft' | 'open' | 'closed' | 'archived', openings: number, applications: number, hired: number, fillRate: number }
interface Report { jobs: Row[], totals: { jobs: number, openings: number, hires: number, fillRate: number } }

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
      <div class="skeleton" style="height: 320px; margin-top: 24px; border-radius: var(--r-panel)" />
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
    </template>
  </div>
</template>

<style scoped>
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
</style>
