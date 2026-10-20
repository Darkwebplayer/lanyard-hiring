<script setup lang="ts">
// Reminder emails link to /tasks/:runId; the task lives in the inbox.
const route = useRoute()
await navigateTo(`/inbox/${route.params.runId}`, { replace: true })
</script>

<template>
  <div />
</template>
