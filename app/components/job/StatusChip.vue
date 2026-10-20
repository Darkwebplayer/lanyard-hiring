<script setup lang="ts">
import type { JobStatus } from '~/composables/useJob'

// "Live" is green like other things that are switched on; accent stays for "a person acts here".
const S: Record<JobStatus, { text: string, chip: string }> = {
  draft: { text: 'Draft', chip: '' },
  open: { text: 'Live', chip: 'chip-ok' },
  closed: { text: 'Closed', chip: '' },
  archived: { text: 'Archived', chip: '' },
}
defineProps<{ status: JobStatus }>()
</script>

<template>
  <span class="chip" :class="S[status].chip">
    <span v-if="status === 'open'" class="dot" aria-hidden="true" />{{ S[status].text }}
  </span>
</template>

<style scoped>
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
</style>
