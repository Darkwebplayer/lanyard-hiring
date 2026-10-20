<script setup lang="ts">
// Copy and open a live job's apply link, wherever the job appears. Compact = icon buttons for table rows.
const props = defineProps<{ jobId: string, compact?: boolean }>()
const url = computed(() => applyUrl(props.jobId))
const copied = ref<boolean | 'failed'>(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  copied.value = (await copyText(url.value)) || 'failed'
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), copied.value === 'failed' ? 4000 : 2000)
}
</script>

<template>
  <span class="apply-actions">
    <button
      type="button" class="btn" :class="compact ? 'btn-quiet btn-icon btn-sm' : ''"
      :aria-label="compact ? (copied === true ? 'Apply link copied' : 'Copy apply link') : undefined"
      :title="compact ? 'Copy apply link' : undefined" @click="copy"
    >
      <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'link'" />
      <span v-if="!compact" aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Copy failed: open it instead' : 'Copy apply link' }}</span>
    </button>
    <a
      :href="url" target="_blank" rel="noopener" class="btn" :class="compact ? 'btn-quiet btn-icon btn-sm' : 'btn-icon'"
      aria-label="Open the apply page in a new tab" title="Open the apply page"
    ><Icon name="external" /></a>
    <span v-if="compact" class="sr-only" aria-live="polite">{{ copied === true ? 'Apply link copied' : copied ? 'Copy failed. Use the open button and copy the address.' : '' }}</span>
  </span>
</template>

<style scoped>
.apply-actions { display: inline-flex; align-items: center; gap: 4px; }
.btn:not(.btn-icon) { min-width: 156px; }
</style>
