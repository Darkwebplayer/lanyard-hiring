<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface Careers {
  company: { name: string | null, careersIntro: string | null, logoUrl: string | null }
  jobs: {
    id: string, title: string, location: string | null, employmentType: string | null
    workplaceType: 'on_site' | 'hybrid' | 'remote' | null
    salary: { min: number | null, max: number | null, currency: string | null } | null
  }[]
}

// Rendered on the server (routeRules) so the list is in the first response, for people and crawlers alike.
const { data, error, refresh } = await useFetch<Careers>('/api/public/jobs')
const company = computed(() => data.value?.company.name?.trim() || null)
useHead({ title: () => (company.value ? `Jobs at ${company.value}` : 'Jobs') })

const rows = computed(() => (data.value?.jobs ?? []).map(j => ({
  ...j,
  place: [j.location, workplaceLabel(j.workplaceType)].filter(Boolean).join(' · '),
  type: typeLabel(j.employmentType),
  pay: salaryText(j.salary),
})))

// A filter appears only when it can split the list: two or more different values.
const distinct = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort()
const places = computed(() => distinct(rows.value.map(r => r.location)))
const types = computed(() => distinct(rows.value.map(r => r.type)))
const place = ref('')
const type = ref('')
const shown = computed(() => rows.value.filter(r => (!place.value || r.location === place.value) && (!type.value || r.type === type.value)))
const filtered = computed(() => !!(place.value || type.value))
function clearFilters() { place.value = ''; type.value = '' }
</script>

<template>
  <div class="careers">
    <header class="top">
      <div class="bar">
        <!-- a logo usually carries the name, so it stands alone -->
        <img v-if="data?.company.logoUrl" :src="data.company.logoUrl" :alt="company ?? 'Careers'" class="logo">
        <template v-else>
          <span v-if="company" class="mono-mark" aria-hidden="true">{{ company[0]!.toUpperCase() }}</span>
          <b>{{ company ?? 'Careers' }}</b>
        </template>
      </div>
    </header>

    <main class="body">
      <div v-if="error" class="state" role="alert">
        <h1>This page didn’t load.</h1>
        <p class="muted">{{ toApiError(error).message }}</p>
        <button class="btn" @click="refresh()">Try again</button>
      </div>

      <template v-else-if="data">
        <div class="intro">
          <h1>Work with us</h1>
          <p v-if="data.company.careersIntro" class="lede">{{ data.company.careersIntro }}</p>
        </div>

        <div v-if="!rows.length" class="state">
          <h2>No open roles right now</h2>
          <p v-if="company" class="muted">When {{ company }} opens a role, it shows here.</p>
        </div>

        <template v-else>
          <div class="filters">
            <select v-if="places.length > 1" v-model="place" aria-label="Location">
              <option value="">All locations</option>
              <option v-for="p in places" :key="p" :value="p">{{ p }}</option>
            </select>
            <select v-if="types.length > 1" v-model="type" aria-label="Type">
              <option value="">All types</option>
              <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
            </select>
            <span class="count" aria-live="polite">{{ plural(shown.length, 'open role') }}</span>
          </div>

          <ul v-if="shown.length" class="jobs">
            <li v-for="j in shown" :key="j.id">
              <NuxtLink :to="`/apply/${j.id}`" class="job">
                <span class="what">
                  <h2>{{ j.title }}</h2>
                  <span v-if="j.place || j.type || j.pay" class="facts">
                    <span v-if="j.place" class="chip">{{ j.place }}</span>
                    <span v-if="j.type" class="chip">{{ j.type }}</span>
                    <span v-if="j.pay" class="chip">{{ j.pay }}</span>
                  </span>
                </span>
                <span class="go" aria-hidden="true">Apply</span>
              </NuxtLink>
            </li>
          </ul>
          <div v-else class="state">
            <h2>No roles match these filters</h2>
            <button class="btn" @click="clearFilters">Show all roles</button>
          </div>
        </template>
      </template>
    </main>
  </div>
</template>

<style scoped>
/* Candidates see ink and paper, as on the apply page: the employer is the brand, not the tool. */
.careers { min-height: 100dvh; }
.top { background: var(--surface); border-bottom: 1px solid var(--line); }
.bar, .body { width: min(880px, 100%); margin-inline: auto; padding-inline: 16px; }
.bar { display: flex; align-items: center; gap: 10px; min-height: 64px; font-size: var(--t-lg); }
.bar b { overflow-wrap: anywhere; }
.logo { display: block; height: 36px; max-width: min(200px, 60vw); object-fit: contain; object-position: left; }
/* the employer's initial, when they have no logo */
.mono-mark { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: 9px; background: var(--ink); color: #fff; font-weight: 600; }
.body { padding-block: 40px 64px; display: grid; gap: 24px; }
.intro { display: grid; gap: 10px; }
.intro h1 { font-size: clamp(var(--t-2xl), 7vw, var(--t-3xl)); letter-spacing: -0.02em; line-height: 1.1; }
.lede { font-size: var(--t-lg); color: var(--ink-2); max-width: 60ch; white-space: pre-line; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.filters select { width: auto; min-height: 44px; max-width: 100%; }
.filters select:focus-visible { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px oklch(0.24 0.018 330 / 0.14); }
.count { margin-left: auto; font-size: var(--t-sm); color: var(--ink-2); }
.jobs { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.job {
  display: flex; align-items: center; gap: 16px; padding: 20px 22px; border-radius: var(--r-card);
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); color: var(--ink); text-decoration: none;
  transition: box-shadow var(--t-micro) var(--ease);
}
.job:hover { box-shadow: inset 0 0 0 1px var(--line-2), 0 10px 28px -12px oklch(0.3 0.04 330 / 0.18); }
.job:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.what { display: grid; gap: 8px; min-width: 0; flex: 1; }
.what h2 { font-size: var(--t-lg); font-weight: 600; overflow-wrap: anywhere; }
.facts { display: flex; gap: 6px; flex-wrap: wrap; }
.facts .chip { height: 24px; font-size: var(--t-xs); white-space: normal; }
.go { flex: none; display: inline-flex; align-items: center; height: var(--h-md); padding: 0 18px; border-radius: var(--r-pill); background: var(--ink); color: #fff; font-weight: 600; }
/* on a phone the whole row is the target; the pill would only squeeze the title */
@media (max-width: 480px) { .go { display: none; } .job { padding: 16px 18px; } }
.state { display: grid; gap: 10px; justify-items: start; padding-top: 8px; }
.state h1 { font-size: var(--t-2xl); }
.state p { font-size: var(--t-lg); }
@media (prefers-reduced-motion: reduce) { .job { transition: none; } }
</style>
