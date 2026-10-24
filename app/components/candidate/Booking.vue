<script setup lang="ts">
// The candidate's booking link for the step they're at. Email isn't wired, so the recruiter sends it.
// Renders nothing when the step has no booking (404) — most steps don't.
const props = defineProps<{ runId: string, firstName: string }>()
interface Booking { url: string, durationMin: number, startsAt: string | null }
const b = ref<Booking | null>(null)
const failed = ref(false)
watch(() => props.runId, async (id) => {
  b.value = null
  failed.value = false
  try { b.value = await api<Booking>(`/api/runs/${id}/booking`) }
  catch (e) { failed.value = toApiError(e).status !== 404 }
}, { immediate: true })

const copied = ref<boolean | 'failed'>(false)
let timer: ReturnType<typeof setTimeout> | undefined
async function copy() {
  copied.value = (await copyText(b.value!.url)) || 'failed'
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), copied.value === 'failed' ? 4000 : 2000)
}
</script>

<template>
  <section v-if="b" class="panel booking" aria-labelledby="book-h">
    <h2 id="book-h" class="sec">Booking link</h2>
    <p v-if="b.startsAt" class="when"><Icon name="calendar" :size="16" /><span>Booked for <b>{{ fmtDateTime(b.startsAt) }}</b>, {{ b.durationMin }} min</span></p>
    <p v-else class="when muted"><Icon name="clock" :size="16" /><span>Not booked yet. Send {{ firstName }} the link to pick a {{ b.durationMin }}-minute slot.</span></p>
    <div class="copy">
      <a :href="b.url" target="_blank" rel="noopener" class="url mono">{{ b.url.replace(/^https?:\/\//, '') }}</a>
      <button type="button" class="btn btn-sm" @click="copy">
        <Icon :name="copied === true ? 'check' : copied ? 'alert' : 'copy'" /><span aria-live="polite">{{ copied === true ? 'Copied' : copied ? 'Select it and copy' : 'Copy link' }}</span>
      </button>
    </div>
  </section>
  <p v-else-if="failed" class="muted small">The booking link didn’t load. Reload the page to try again.</p>
</template>

<style scoped>
.booking { padding: 18px; display: grid; gap: 10px; }
.sec { font-size: var(--t-lg); margin: 0; }
.when { display: flex; gap: 8px; align-items: flex-start; font-size: var(--t-sm); }
.when svg { flex: none; margin-top: 2px; color: var(--ink-2); }
/* the same pill as the job's apply link (job/CopyLink.vue) */
.copy { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 14px; border-radius: var(--r-pill); background: var(--sunk); }
.url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); color: var(--ink); text-decoration: none; }
.url:hover { text-decoration: underline; }
.copy .btn { flex: none; min-width: 108px; }
.small { font-size: var(--t-sm); }
</style>
