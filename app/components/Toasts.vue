<script setup lang="ts">
const { queue, dismiss } = useToast()
const current = computed(() => queue.value[0])
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-if="current" :key="current.id" class="toast">
      <span>{{ current.text }}</span>
      <button v-if="current.action" class="btn" @click="current.action.run(); dismiss(current.id)">{{ current.action.label }}</button>
      <button class="btn btn-icon btn-sm" aria-label="Dismiss" @click="dismiss(current.id)"><Icon name="x" :size="14" /></button>
    </div>
  </div>
</template>
