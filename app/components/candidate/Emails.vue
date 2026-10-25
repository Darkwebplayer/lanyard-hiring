<script setup lang="ts">
import { type Timeline, stepName } from './Trace.vue'

// "Emails to <first name>": every email sent to the candidate, word for word. The newest is open, the rest fold.
const props = defineProps<{ tl: Timeline }>()
interface Email { id: string, kind: string, key: string, to: string, replyTo: string | null, subject: string, body: string | null, createdAt: string, sentAt: string | null, failedAt: string | null } // body: managers only

const emails = ref<Email[] | null>(null)
const failed = ref(false)
watch(() => props.tl, async () => {
  try { emails.value = await api<Email[]>(`/api/applications/${props.tl.application.id}/emails`); failed.value = false }
  catch { failed.value = true }
}, { immediate: true })

const KIND: Record<string, string> = {
  offer: 'Make offer', offer_accepted: 'their answer to the offer', offer_declined: 'their answer to the offer',
  booking_request: 'the booking link', booked: 'their booking', rejection: 'a close by hand',
}
// flow emails are keyed by the step's run: name the step
const source = (e: Email) => e.kind === 'flow' ? stepName(props.tl, props.tl.runs.find(r => r.id === e.key)?.nodeKey ?? 'send_email') : KIND[e.kind] ?? e.kind
</script>

<template>
  <section v-if="emails?.length || failed" class="panel emails" aria-labelledby="emails-h">
    <div class="ehead">
      <h2 id="emails-h" class="sec">Emails to {{ tl.candidate.firstName }}</h2>
      <span v-if="emails" class="faint">{{ plural(emails.length, 'sent', 'sent') }}</span>
    </div>
    <p class="faint">Every email sent to the candidate. This is your record.</p>
    <p v-if="failed" class="muted">The emails didn’t load. Reload the page to try again.</p>
    <template v-else-if="emails">
      <details v-for="(e, i) in emails" :key="e.id" class="mail" :open="i === 0">
        <summary><b>{{ e.subject }}</b><time class="faint" :datetime="e.sentAt ?? e.createdAt">{{ fmtDate(e.sentAt ?? e.createdAt) }}</time></summary>
        <p class="faint meta">To {{ e.to }}<template v-if="e.replyTo"> · Reply-to {{ e.replyTo }}</template> · Sent by {{ source(e) }}<template v-if="e.failedAt"> · Not sent, gave up</template><template v-else-if="!e.sentAt"> · Not sent yet</template></p>
        <p v-if="e.body !== null" class="body">{{ e.body }}</p>
        <p v-else class="faint">Only managers can read the email itself: it holds the candidate’s private links.</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.emails { padding: 18px; display: grid; gap: 10px; }
.ehead { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.sec { font-size: var(--t-lg); margin: 0; }
.faint { font-size: var(--t-xs); color: var(--ink-3); }
.mail { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 8px; }
.mail[open] { border: 1px solid var(--line); border-radius: var(--r-panel); padding: 12px 14px; }
.mail summary { display: flex; justify-content: space-between; gap: 8px; cursor: pointer; font-size: var(--t-sm); }
.mail summary b { font-weight: 600; overflow-wrap: anywhere; }
.mail time { white-space: nowrap; }
.meta { overflow-wrap: anywhere; }
.body { margin: 0; font-size: var(--t-sm); line-height: 1.5; color: var(--ink-2); background: var(--sunk); border-radius: var(--r-field); padding: 10px 12px; white-space: pre-line; overflow-wrap: anywhere; }
</style>
