<script setup lang="ts">
const route = useRoute()
const id = route.params.id as string
const { flowPresets, error, refresh } = useFlowPresets()
const preset = computed(() => flowPresets.value?.find(p => p.id === id))
useHead({ title: () => (preset.value ? `${preset.value.name} · Workflows` : 'Workflows') })

// Standard hire comes with the app and can't change; its page in the list says to duplicate it.
if (id === 'standard') navigateTo('/library/flows?flow=standard', { replace: true })

// The editors clone the preset once, so they open only on a fresh list: a stale cached one could be saved over newer edits.
const loaded = ref(false)
async function load() {
  loaded.value = false
  await refresh()
  loaded.value = true
}
onMounted(() => { if (id !== 'standard') load() })

const base = `/library/flows/${id}`
const tabs = [
  { to: base, label: 'Flow' },
  { to: `${base}/form`, label: 'Application form' },
]
// the Flow tab is the index route, so it is the one that gets the full width
const isFlow = computed(() => route.path === base)
</script>

<template>
  <div class="page" :class="{ wide: isFlow }">
    <NuxtLink :to="{ path: '/library/flows', query: { flow: id } }" class="crumb"><Icon name="chevron-left" :size="14" />Workflows</NuxtLink>

    <div v-if="!loaded" aria-busy="true" aria-label="Loading the workflow template">
      <header class="page-head">
        <div class="head">
          <span class="skeleton" style="display:block;width:320px;height:30px" />
          <p class="sub">Workflow template · Jobs that already started from it keep their own copy.</p>
        </div>
      </header>
      <nav class="tabs" aria-label="Flow preset">
        <NuxtLink v-for="t in tabs" :key="t.to" :to="t.to" :aria-current="route.path === t.to ? 'page' : undefined">{{ t.label }}</NuxtLink>
      </nav>
      <div v-if="isFlow" class="loading">
        <div class="skeleton pal" />
        <div class="cards"><div v-for="i in 4" :key="i" class="skeleton card-sk" /></div>
      </div>
      <div v-else class="skeleton form-sk" />
    </div>

    <section v-else-if="error" class="panel empty" role="alert">
      <h1>The workflow templates didn’t load</h1>
      <p>{{ error.message }}</p>
      <button type="button" class="btn" @click="load">Retry</button>
    </section>

    <section v-else-if="!preset" class="panel empty">
      <h1>This workflow template doesn’t exist</h1>
      <p>It may have been deleted, or the link is wrong.</p>
      <NuxtLink to="/library/flows" class="btn">Back to workflows</NuxtLink>
    </section>

    <template v-else>
      <header class="page-head">
        <div class="head">
          <h1>{{ preset.name }}</h1>
          <p class="sub">Workflow template · Jobs that already started from it keep their own copy.</p>
        </div>
      </header>
      <nav class="tabs" aria-label="Flow preset">
        <NuxtLink v-for="t in tabs" :key="t.to" :to="t.to" :aria-current="route.path === t.to ? 'page' : undefined">{{ t.label }}</NuxtLink>
      </nav>
      <div class="tab-body">
        <NuxtPage />
      </div>
    </template>
  </div>
</template>

<style scoped>
.page.wide { max-width: none; }
.empty h1 { color: var(--ink); font-size: var(--t-xl); }
.page-head { margin-bottom: 16px; }
.head { min-width: 0; flex: 1 1 420px; }
.head h1 { overflow-wrap: anywhere; }
.tab-body { padding-top: 20px; }
.loading { display: grid; grid-template-columns: 220px 1fr; height: max(560px, calc(100dvh - 200px)); margin-top: 20px; border-top: 1px solid var(--line); }
.pal { border-radius: 0; }
.cards { display: grid; justify-items: center; align-content: start; gap: 64px; padding-top: 56px; background: var(--bg); }
.card-sk { width: 240px; height: 96px; border-radius: 16px; }
.form-sk { height: 360px; margin-top: 20px; border-radius: var(--r-panel); }
</style>
