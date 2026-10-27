<script setup lang="ts">
// The candidate's interview for the step they're at, and their link. The link went out with the offered times;
// Copy link is for resending by hand.
// Renders nothing when the step has no booking (404) — most steps don't.
const props = defineProps<{ runId: string, firstName: string }>()
interface Booking { url: string, durationMin: number, startsAt: string | null, location: string | null, cancelledAt: string | null, declinedAt: string | null, sentAt: string | null, note: string | null, notedAt: string | null }
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
    <h2 id="book-h" class="sec">Interview booking</h2>
    <p v-if="b.cancelledAt" class="when muted"><Icon name="calendar" :size="16" /><span>Cancelled. It was booked for {{ fmtBooked(b.startsAt) }}.</span></p>
    <p v-else-if="b.declinedAt" class="when"><Icon name="alert" :size="16" /><span>{{ firstName }} stepped back from the interview<template v-if="b.note">: “{{ b.note }}”</template>. Nothing has closed.</span></p>
    <p v-else-if="b.startsAt" class="when"><Icon name="calendar" :size="16" /><span>Booked for <b>{{ fmtBooked(b.startsAt) }}</b>, {{ b.durationMin }} min</span></p>
    <p v-if="!b.cancelledAt && !b.declinedAt && b.notedAt" class="when muted"><Icon name="clock" :size="16" /><span>{{ firstName }} asked for other times<template v-if="b.note">: “{{ b.note }}”</template></span></p>
    <p v-else-if="!b.cancelledAt && !b.declinedAt && b.sentAt" class="when muted"><Icon name="clock" :size="16" /><span>We emailed {{ firstName }} the offered times. Waiting for a pick.</span></p>
    <p v-else-if="!b.cancelledAt && !b.declinedAt && !b.startsAt" class="when muted"><Icon name="clock" :size="16" /><span>No times offered yet. The interviewer offers them from their inbox, under Schedule.</span></p>
    <p v-if="b.location" class="when"><Icon name="pin" :size="16" /><span>{{ b.location }}</span></p>
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
