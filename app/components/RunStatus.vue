<script setup lang="ts">
// A run's status as a word with an icon; colour never carries it alone.
const props = defineProps<{ status: string, overdue?: boolean }>()
const s = computed(() => props.overdue && props.status === 'waiting_on_human'
  ? { text: 'Late', chip: 'chip-bad', icon: 'clock' }
  : RUN_STATUS[props.status] ?? { text: props.status, chip: '', icon: 'more' })
</script>

<template>
  <span class="chip" :class="s.chip"><span v-if="status === 'running'" class="spinner" style="width:10px;height:10px;border-width:1.5px" /><Icon v-else :name="s.icon" :size="12" />{{ s.text }}</span>
</template>
