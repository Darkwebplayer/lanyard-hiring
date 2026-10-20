<script setup lang="ts">
const props = defineProps<{ due: string | null, overdue?: boolean }>()
const d = computed(() => fmtDue(props.due))
</script>

<template>
  <span class="chip" :class="d.late || overdue ? 'chip-bad' : d.soon ? 'chip-warn' : ''"><Icon name="clock" :size="12" />{{ d.text }}</span>
</template>
