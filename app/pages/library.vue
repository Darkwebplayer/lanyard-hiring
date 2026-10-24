<script setup lang="ts">
const route = useRoute()
const tabs = [
  { to: '/library', label: 'Steps' },
  { to: '/library/flows', label: 'Flows' },
  { to: '/library/offers', label: 'Offer letters' },
]
</script>

<template>
  <!-- a flow preset's editor brings its own header and wide canvas, so no Library tabs above it.
       ponytail: keyed on params.id (only that editor has one); switch to route.name if another library page gets an id -->
  <NuxtPage v-if="route.params.id" />
  <div v-else class="page">
    <header class="page-head">
      <h1>Library</h1>
    </header>
    <nav class="tabs" aria-label="Library">
      <NuxtLink v-for="t in tabs" :key="t.to" :to="t.to" :aria-current="route.path === t.to ? 'page' : undefined">{{ t.label }}</NuxtLink>
    </nav>
    <div class="tab-body">
      <NuxtPage />
    </div>
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 16px; }
.tab-body { padding-top: 20px; }
</style>
