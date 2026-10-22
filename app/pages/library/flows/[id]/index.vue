<script setup lang="ts">
import FlowEditor from '~/components/flow/FlowEditor.vue'

const source = useFlowPresetSource(useRoute().params.id as string)
</script>

<template>
  <div class="flow-page">
    <h2 class="sr-only">Flow</h2>
    <FlowEditor v-if="source.workflow.value" :source="source" />
  </div>
</template>

<style scoped>
.flow-page { min-width: 0; }
</style>
