<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface Offer {
  company: string | null, jobTitle: string, candidateFirstName: string, letter: string
  terms: { salary: string, start_date: string, location?: string }
  status: 'sent' | 'accepted' | 'declined' | 'withdrawn', expiresAt: string | null
  signedName: string | null, respondedAt: string | null
}

const token = useRoute().params.token as string
const base = `/api/public/offers/${encodeURIComponent(token)}`
const offer = ref<Offer | null>(null)
const loadError = ref<{ status: number, message: string } | null>(null)
async function load() {
  loadError.value = null
  try {
    offer.value = await api<Offer>(base)
  }
  catch (e) {
    const err = toApiError(e)
    loadError.value = { status: err.status, message: err.message }
  }
}
onMounted(load)
useHead({ title: () => (offer.value ? `Your offer · ${offer.value.jobTitle}` : 'Your offer') })

const company = computed(() => offer.value?.company || 'the team')
const expiredNow = ref(false) // the server said so after the page loaded
const state = computed(() => {
  const o = offer.value
  if (!o) return null
  if (o.status !== 'sent') return o.status
  return expiredNow.value || (o.expiresAt && new Date(o.expiresAt).getTime() <= Date.now()) ? 'expired' : 'open'
})
const letterHtml = computed(() => renderMarkdown(offer.value?.letter ?? ''))
const dateF = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
const shortF = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
// "2027-01-04" is a calendar day, not an instant: build it in local time so no zone moves it a day
const startDate = computed(() => {
  const [y, m, d] = (offer.value?.terms.start_date ?? '').split('-').map(Number)
  return y && m && d ? dateF.format(new Date(y, m - 1, d)) : offer.value?.terms.start_date
})

// ---- respond ----
const name = ref('')
const agree = ref(false)
const nameError = ref('')
const formError = ref('')
const busy = ref<'accept' | 'decline' | null>(null)
const declining = ref(false)
const declineH = ref<HTMLElement>()
const declineBtn = ref<HTMLButtonElement>()
const justNow = ref(false)

async function startDecline() {
  declining.value = true
  formError.value = ''
  await nextTick()
  declineH.value?.focus()
}
async function keep() {
  declining.value = false
  await nextTick()
  declineBtn.value?.focus()
}

async function respond(body: { action: 'accept', signedName: string } | { action: 'decline' }) {
  busy.value = body.action
  nameError.value = ''
  formError.value = ''
  try {
    const { status } = await api<{ status: Offer['status'] }>(base, { method: 'POST', body })
    offer.value!.status = status
    justNow.value = true
    window.scrollTo({ top: 0 })
  }
  catch (e) {
    const err = toApiError(e)
    if (err.code === 'name_mismatch') nameError.value = `Type your first and last name as ${company.value} has them. Check the spelling.`
    else if (err.code === 'offer_expired') expiredNow.value = true
    else if (err.code === 'offer_not_open' || err.status === 404) await load()
    else formError.value = err.message
  }
  finally {
    busy.value = null
  }
}
const print = () => window.print()
</script>

<template>
  <main class="offer">
    <header class="brand noprint">
      <span v-if="offer?.company" class="mono-mark" aria-hidden="true">{{ offer.company[0]!.toUpperCase() }}</span>
      <b>{{ offer?.company }}</b>
      <button v-if="state === 'open' || state === 'accepted'" type="button" class="btn btn-sm" @click="print"><Icon name="download" />Save as PDF</button>
    </header>

    <div v-if="loadError?.status === 404" class="card sheet">
      <h1>This offer link doesn’t work</h1>
      <p class="muted">It may be mistyped, or a newer offer replaced it. Reply to the email that brought you here and ask for the current link.</p>
    </div>

    <div v-else-if="loadError" class="card sheet" role="alert">
      <h1>This page didn’t load.</h1>
      <p class="muted">{{ loadError.message }}</p>
      <button class="btn" @click="load">Try again</button>
    </div>

    <div v-else-if="!offer" class="card sheet" aria-busy="true">
      <div class="skeleton" style="height: 30px; width: 60%" />
      <div class="skeleton" style="height: 72px" />
      <div class="skeleton" style="height: 200px" />
    </div>

    <template v-else>
      <!-- endings first, so the answer is the first thing on the page -->
      <section v-if="state === 'accepted'" class="card sheet ending noprint" data-slot="ok" aria-live="polite">
        <h2>{{ justNow ? `Welcome to ${offer.company ?? 'the team'}, ${offer.candidateFirstName}` : 'You accepted this offer' }}</h2>
        <p class="muted">{{ justNow ? `You’ve accepted the ${offer.jobTitle} offer. ${offer.company ?? 'The team'} will be in touch about your first day.` : `Your signed offer for ${offer.jobTitle} is below. Save a copy with Save as PDF.` }}</p>
      </section>
      <div v-else-if="state === 'declined'" class="card sheet" aria-live="polite">
        <h1>You declined this offer</h1>
        <p class="muted">{{ justNow ? `Thank you for letting ${company} know.` : `You told ${company} you won’t take the ${offer.jobTitle} role.` }} If you change your mind, reply to their email.</p>
      </div>
      <div v-else-if="state === 'withdrawn'" class="card sheet">
        <h1>This offer is no longer open</h1>
        <p class="muted">{{ offer.company ?? 'The team' }} withdrew it. If they made you a new offer, use the link in their latest email. Questions? Reply to them directly.</p>
      </div>
      <div v-else-if="state === 'expired'" class="card sheet">
        <h1>This offer has expired</h1>
        <p class="muted">It was open until {{ offer.expiresAt ? shortF.format(new Date(offer.expiresAt)) : 'a date that has passed' }}. If you still want the {{ offer.jobTitle }} role, reply to the email from {{ company }}.</p>
      </div>

      <article v-if="state === 'open' || state === 'accepted'" class="card sheet letter" aria-labelledby="letter-h">
        <p class="print-only company">{{ offer.company }}</p>
        <h1 id="letter-h">Your offer, {{ offer.candidateFirstName }}</h1>
        <dl class="terms">
          <div><dt>Salary</dt><dd>{{ offer.terms.salary }}</dd></div>
          <div><dt>Start date</dt><dd>{{ startDate }}</dd></div>
          <div v-if="offer.terms.location"><dt>Where</dt><dd>{{ offer.terms.location }}</dd></div>
        </dl>
        <!-- renderMarkdown escapes all HTML before adding its few tags -->
        <div class="prose" v-html="letterHtml" />
        <p v-if="state === 'accepted' && offer.signedName" class="signed">
          Accepted by <b>{{ offer.signedName }}</b><template v-if="offer.respondedAt"> on {{ shortF.format(new Date(offer.respondedAt)) }}</template>
        </p>
      </article>

      <section v-if="state === 'open'" class="card sheet respond noprint" aria-labelledby="acc-h">
        <form v-if="!declining" class="accept" @submit.prevent="respond({ action: 'accept', signedName: name })">
          <h2 id="acc-h">Accept this offer</h2>
          <div class="field">
            <label for="sig">Type your full name to sign</label>
            <input
              id="sig" v-model="name" class="sig" autocomplete="name" required maxlength="300"
              :aria-invalid="nameError ? 'true' : undefined" :aria-describedby="nameError ? 'sig-e' : undefined" @input="nameError = ''"
            >
            <p v-if="nameError" id="sig-e" class="error"><Icon name="alert" :size="16" />{{ nameError }}</p>
          </div>
          <label class="check"><input v-model="agree" type="checkbox" required><span>I accept this offer on the terms above.</span></label>
          <p v-if="formError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ formError }}</p>
          <div class="row">
            <button class="btn btn-primary btn-lg" :aria-busy="busy === 'accept'" :disabled="!!busy">
              <span v-if="busy === 'accept'" class="spinner" /><span>Accept offer</span>
            </button>
            <button ref="declineBtn" type="button" class="btn btn-lg" @click="startDecline">Decline…</button>
            <span v-if="offer.expiresAt" class="until">Open until {{ shortF.format(new Date(offer.expiresAt)) }}</span>
          </div>
        </form>

        <div v-else class="decline">
          <h2 ref="declineH" tabindex="-1">Decline this offer?</h2>
          <p class="muted">{{ offer.company ?? 'The team' }} will be told, and you won’t be able to accept it from this page afterwards.</p>
          <p v-if="formError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ formError }}</p>
          <div class="row">
            <button type="button" class="btn btn-danger btn-lg" :aria-busy="busy === 'decline'" :disabled="!!busy" @click="respond({ action: 'decline' })">
              <span v-if="busy === 'decline'" class="spinner" /><span>Decline offer</span>
            </button>
            <button type="button" class="btn btn-lg" @click="keep">Keep the offer</button>
          </div>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.offer { width: min(680px, 100%); margin-inline: auto; padding: 40px 16px 64px; display: grid; gap: 18px; align-content: start; }
.offer :deep(:where(input[type="checkbox"]):checked) { background: var(--ink); border-color: var(--ink); }
.offer :deep(:where(input):focus-visible) { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px oklch(0.24 0.018 330 / 0.14); }
.offer :deep(:focus-visible) { outline-color: var(--ink); }
.brand { display: flex; align-items: center; gap: 10px; min-height: 34px; }
.brand b { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mono-mark { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--ink); color: #fff; font-size: var(--t-xs); font-weight: 600; }
.sheet { padding: 24px; display: grid; gap: 14px; box-shadow: inset 0 0 0 1px var(--line); border: 0; }
.sheet h1 { font-size: var(--t-2xl); letter-spacing: -0.015em; overflow-wrap: anywhere; }
.sheet h2 { font-size: var(--t-xl); }
.ending { padding-top: 30px; }
.letter { padding: 32px; gap: 18px; }
@media (max-width: 480px) { .sheet, .letter { padding: 20px 16px; } .ending { padding-top: 28px; } }
.letter h1:focus { outline: none; }
.letter .prose { font-size: var(--t-lg); max-width: none; }
/* the terms the signature refers to, set apart from the template text */
/* flex, not an auto-fit grid: a term that wraps alone grows to fill its row, so no empty line-coloured cell is left */
.terms { margin: 0; display: flex; flex-wrap: wrap; gap: 1px; border-radius: var(--r-panel); overflow: hidden; background: var(--line); box-shadow: inset 0 0 0 1px var(--line); }
.terms div { flex: 1 1 150px; padding: 12px 16px; background: var(--sunk); display: grid; gap: 2px; }
.terms dt { font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); }
.terms dd { margin: 0; font-size: var(--t-lg); font-weight: 600; overflow-wrap: anywhere; }
/* the signature line the ending card refers to; printed with the letter */
.signed { margin: 0; padding-top: 14px; border-top: 1px solid var(--line); font-size: var(--t-md); color: var(--ink-2); }
.signed b { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.accept, .decline { display: grid; gap: 16px; }
.decline h2:focus { outline: none; }
.sig { min-height: var(--h-lg); font-size: var(--t-xl); }
.check { font-size: var(--t-md); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.until { margin-left: auto; font-size: var(--t-sm); color: var(--ink-2); }
.print-only { display: none; }

/* Save as PDF prints the letter alone: no buttons, no answer form, no card chrome. */
@media print {
  .noprint { display: none !important; }
  .print-only { display: block; }
  .offer { width: auto; padding: 0; }
  .letter { box-shadow: none; padding: 0; border-radius: 0; }
  .letter .company { font-weight: 600; margin-bottom: 12px; }
  .terms { break-inside: avoid; }
}
</style>
