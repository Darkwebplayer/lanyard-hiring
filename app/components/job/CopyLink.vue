<script setup lang="ts">
// The apply link with a Copy button that answers in place.
const props = defineProps<{ jobId: string }>()
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
  <div class="copy-link">
    <a :href="url" target="_blank" rel="noopener" class="url mono">{{ url }}</a>
    <button type="button" class="btn btn-sm" @click="copy">
      <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'copy'" /><span aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Select it and copy' : 'Copy link' }}</span>
    </button>
  </div>
</template>

<style scoped>
.copy-link {
  display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%;
  padding: 4px 4px 4px 14px; border-radius: var(--r-pill); background: var(--sunk);
}
.url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); color: var(--ink); text-decoration: none; }
.url:hover { text-decoration: underline; }
.btn { flex: none; min-width: 108px; }
</style>
