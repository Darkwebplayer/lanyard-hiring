<script setup lang="ts">
import FlowEditor from '~/components/flow/FlowEditor.vue'

const route = useRoute()
const id = computed(() => String(route.params.id))
const { detail, editable, error, refresh } = useJob(id.value)
if (!detail.value) refresh()
useHead({ title: () => (detail.value ? `Flow · ${detail.value.job.title}` : 'Flow') })
</script>

<template>
  <div class="flow-page">
    <h2 class="sr-only">Flow</h2>
    <FlowEditor v-if="editable" :key="id" :job-id="id" />
    <div v-else-if="error" class="empty" role="alert">
      <h3>The flow didn’t load</h3>
      <p>{{ error.message }}</p>
      <button type="button" class="btn" @click="refresh">Retry</button>
    </div>
    <div v-else-if="detail" class="empty">
      <h3>This job has no flow yet</h3>
    </div>
    <div v-else class="loading" aria-busy="true" aria-label="Loading the flow">
      <div class="skeleton pal" />
      <div class="cards">
        <div v-for="i in 4" :key="i" class="skeleton card-sk" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-page { min-width: 0; }
.loading { display: grid; grid-template-columns: 220px 1fr; height: max(560px, calc(100dvh - 160px)); border-top: 1px solid var(--line); }
.pal { border-radius: 0; }
.cards { display: grid; justify-items: center; align-content: start; gap: 64px; padding-top: 56px; background: var(--bg); }
.card-sk { width: 240px; height: 96px; border-radius: 16px; }
</style>
