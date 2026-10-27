<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface App {
  id: string, job: string, appliedAt: string, steps: string[], step: number
  outcome: 'hired' | 'rejected' | 'withdrawn' | null, closedAt: string | null
  interview: { startsAt: string, url: string } | null, offerUrl: string | null, startDate: string | null
}
interface Todo { kind: 'book' | 'documents' | 'offer', applicationId: string, job: string, url: string, durationMin?: number, until?: string | null }
interface Status {
  companyName: string | null, logoUrl: string | null, contactEmail: string | null, firstName: string
  applications: App[], todo: Todo[], updates: { id: string, applicationId: string, job: string, subject: string, body: string, sentAt: string }[]
}

const token = useRoute().params.token as string
const d = ref<Status | null>(null)
const loadError = ref<{ status: number, message: string } | null>(null)
// the link is the key: keep it out of search engines and out of the Referer of every link on the page
useHead({
  title: () => (d.value?.companyName ? `Your applications · ${d.value.companyName}` : 'Your applications'),
  meta: [{ name: 'robots', content: 'noindex' }, { name: 'referrer', content: 'no-referrer' }],
})

// "New" = sent since their last visit, remembered in this browser only; a first visit marks nothing
const SEEN = `status-seen:${token}`
const seen = ref<string | null>(null)
async function load() {
  loadError.value = null
  try {
    d.value = await api<Status>(`/api/public/status/${encodeURIComponent(token)}`)
    try {
      seen.value = localStorage.getItem(SEEN)
      localStorage.setItem(SEEN, new Date().toISOString())
    }
    catch {}
  }
  catch (e) {
    const err = toApiError(e)
    loadError.value = { status: err.status, message: err.message }
  }
}
onMounted(load)

// the boot screen hangs the badge 1 s after the first byte; the page's own wait carries on from the same moment
const badgeDelay = import.meta.client ? `${Math.max(0, 1000 - performance.now())}ms` : '1s'

const TODO = {
  book: (t: Todo) => ({ title: 'Pick a time for your interview', sub: `${t.job} · ${t.durationMin} minutes`, cta: 'Pick a time', waiting: 'Waiting for you to pick an interview time.' }),
  documents: (t: Todo) => ({ title: 'Send a few documents', sub: t.job, cta: 'Send documents', waiting: 'Waiting for your documents.' }),
  offer: (t: Todo) => ({ title: `You have an offer for ${t.job}`, sub: t.until ? `Open until ${fmtLongDate(t.until)}` : 'Read it and answer when you’re ready', cta: 'Read your offer', waiting: 'Waiting for your answer to the offer.' }),
}
const todos = computed(() => (d.value?.todo ?? []).map(t => ({ ...t, ...TODO[t.kind](t) })))
const active = computed(() => d.value?.applications.filter(a => !a.outcome) ?? [])
const hired = computed(() => d.value?.applications.filter(a => a.outcome === 'hired') ?? [])
const ended = computed(() => d.value?.applications.filter(a => a.outcome && a.outcome !== 'hired') ?? [])
function line(a: App) {
  const t = todos.value.find(x => x.applicationId === a.id)
  if (t) return t.waiting
  if (a.interview) return `Your interview: ${fmtBooked(a.interview.startsAt, true)}.`
  return 'The team is working on it. We’ll email you when there’s news.'
}

// the footer that links back here is noise on this page; links in the text stay clickable
const URL_RE = /(https?:\/\/\S+)/
const bodyParts = (body: string) => body.replace(/\n\nFollow your applications[^\n]*:\n\S+\s*$/, '').split(URL_RE)
const isNew = (sentAt: string) => !!seen.value && sentAt > seen.value
const showAll = ref(false)
const updates = computed(() => (showAll.value ? d.value?.updates : d.value?.updates.slice(0, 5)) ?? [])

function fmtLongDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}
const startLine = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

// lost or broken link: ask for a new one by email; the answer is the same whatever the address
const email = ref('')
const asking = ref(false)
const asked = ref(false)
const askError = ref('')
async function askLink() {
  askError.value = ''
  asking.value = true
  try {
    await api('/api/public/status/link', { method: 'POST', body: { email: email.value } })
    asked.value = true
  }
  catch (e) {
    askError.value = toApiError(e).message
  }
  finally {
    asking.value = false
  }
}
</script>

<template>
  <main class="status">
    <p v-if="d?.logoUrl" class="brand"><img :src="d.logoUrl" :alt="d.companyName ?? 'Company logo'" class="logo"></p>
    <p v-else-if="d?.companyName" class="brand"><span class="mono-mark" aria-hidden="true">{{ d.companyName[0]!.toUpperCase() }}</span><b>{{ d.companyName }}</b></p>

    <section v-if="loadError?.status === 404" class="card sheet" aria-labelledby="lost-h">
      <div>
        <h1 id="lost-h">This link doesn’t work</h1>
        <p class="sub">It may be mistyped or cut off. Enter the email you applied with and we’ll send you a fresh link.</p>
      </div>
      <div v-if="asked" role="status" class="sent">
        <h2>Check your inbox</h2>
        <p class="sub">If that email has applied with us, a new link is on its way. It can take a minute or two.</p>
      </div>
      <form v-else class="ask" @submit.prevent="askLink">
        <div class="field">
          <label for="st-email">Email</label>
          <input id="st-email" v-model="email" type="email" required autocomplete="email" placeholder="e.g. weiming.tan@gmail.com">
        </div>
        <p v-if="askError" class="form-error" role="alert"><Icon name="alert" :size="14" />{{ askError }}</p>
        <button class="btn btn-dark btn-lg" :aria-busy="asking" :disabled="asking"><span v-if="asking" class="spinner" />Email me a link</button>
      </form>
    </section>

    <div v-else-if="loadError" class="card sheet" role="alert">
      <h1>This page didn’t load.</h1>
      <p class="sub">{{ loadError.message }}</p>
      <button class="btn" @click="load">Try again</button>
    </div>

    <!-- the boot screen's badge, still being checked while we find their applications -->
    <div v-else-if="!d" class="wait" :style="{ '--delay': badgeDelay }">
      <div class="hang" aria-hidden="true"><span class="strap" /><span class="badge" /></div>
      <p role="status">Finding your applications…</p>
    </div>

    <template v-else>
      <div>
        <h1>Hi {{ d.firstName }}</h1>
        <p class="sub">
          {{ d.applications.length === 1 ? 'Your application' : `Your ${d.applications.length} applications` }}{{ d.companyName ? ` with ${d.companyName}` : '' }}.
          This link is just for you, so please don’t share it.
        </p>
      </div>

      <!-- signature: what waits on them, first -->
      <section v-for="(t, i) in todos" :key="t.url" class="card turn" :aria-labelledby="`todo-${i}`">
        <p class="eyebrow turn-eye">Your turn</p>
        <div>
          <h2 :id="`todo-${i}`">{{ t.title }}</h2>
          <p class="sub">{{ t.sub }}</p>
        </div>
        <NuxtLink :to="t.url" class="btn btn-lg" :class="i === 0 ? 'btn-primary' : 'btn-dark'">{{ t.cta }}</NuxtLink>
      </section>

      <!-- endings: a hire gets a real moment, not a full bar -->
      <article v-for="a in hired" :key="a.id" class="card app welcome">
        <span class="chip chip-ok"><Icon name="check" :size="12" />You accepted</span>
        <h2>Welcome{{ d.companyName ? ` to ${d.companyName}` : '' }}, {{ d.firstName }}</h2>
        <p class="sub">You’re joining as {{ a.job }}<template v-if="a.startDate">, starting {{ startLine(a.startDate) }}</template>. We’ll email you about your first day.</p>
        <NuxtLink v-if="a.offerUrl" :to="a.offerUrl" class="btn">Your offer letter</NuxtLink>
      </article>

      <section v-if="active.length" aria-label="Applications" class="apps">
        <article v-for="a in active" :key="a.id" class="card app">
          <div class="app-head">
            <h3>{{ a.job }}</h3>
            <span class="when">Applied {{ fmtDate(a.appliedAt) }}</span>
          </div>
          <ol class="bar" :style="{ '--n': a.steps.length }" :aria-label="`Progress: step ${a.step + 1} of ${a.steps.length}, ${a.steps[a.step]}`">
            <li v-for="(s, i) in a.steps" :key="i" :class="{ done: i < a.step, now: i === a.step }" :aria-current="i === a.step ? 'step' : undefined">
              <span class="seg" /><span class="lbl">{{ s }}</span>
            </li>
          </ol>
          <p class="line">
            {{ line(a) }}
            <NuxtLink v-if="a.interview && !todos.some(t => t.applicationId === a.id)" :to="a.interview.url">Change time</NuxtLink>
          </p>
        </article>
      </section>

      <!-- not selected or ended: quiet, below the rest; their email already said it -->
      <article v-for="a in ended" :key="a.id" class="app ended">
        <div class="app-head">
          <h3>{{ a.job }}</h3>
          <span class="when">Closed {{ fmtDate(a.closedAt) }}</span>
        </div>
        <p class="line">{{ a.outcome === 'rejected' ? 'We didn’t move forward with this one.' : 'This application has ended.' }} Our email from {{ fmtDate(a.closedAt) }} is in Updates below.</p>
      </article>

      <section v-if="d.updates.length" aria-labelledby="up-h" class="updates">
        <h2 id="up-h">Updates</h2>
        <ul>
          <li v-for="u in updates" :key="u.id">
            <details>
              <summary>
                <span class="u-top"><b>{{ u.subject }}</b><span v-if="isNew(u.sentAt)" class="chip chip-accent">New</span></span>
                <span class="when">{{ d.applications.length > 1 ? `${u.job} · ` : '' }}{{ fmtDateTime(u.sentAt) }}</span>
              </summary>
              <p class="u-body"><template v-for="(part, i) in bodyParts(u.body)" :key="i"><a v-if="i % 2" :href="part" rel="noreferrer">{{ part }}</a><template v-else>{{ part }}</template></template></p>
            </details>
          </li>
        </ul>
        <button v-if="!showAll && d.updates.length > 5" type="button" class="btn btn-quiet btn-sm more" @click="showAll = true">{{ plural(d.updates.length - 5, 'earlier update') }}</button>
      </section>

      <p class="foot">
        Questions? Reply to any of our emails<template v-if="d.contactEmail">, or write to <a :href="`mailto:${d.contactEmail}`">{{ d.contactEmail }}</a></template>.
        <template v-if="!active.length"><br>See something else you’d like? <NuxtLink to="/careers">All open jobs</NuxtLink></template>
      </p>
    </template>
  </main>
</template>

<style scoped>
/* Ink and paper like the other candidate pages; one column a phone reads top to bottom. */
.status { width: min(560px, 100%); margin-inline: auto; padding: 40px 16px 64px; display: grid; gap: 20px; align-content: start; }
.status :deep(:focus-visible) { outline-color: var(--ink); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand b { overflow-wrap: anywhere; }
.logo { display: block; height: 32px; max-width: min(180px, 60vw); object-fit: contain; object-position: left; }
.mono-mark { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--ink); color: #fff; font-size: var(--t-xs); font-weight: 600; }
h1 { overflow-wrap: anywhere; }
.sub { margin-top: 6px; color: var(--ink-2); }
.sheet { padding: 24px; display: grid; gap: 18px; box-shadow: inset 0 0 0 1px var(--line); border: 0; }
.card.app, .card.turn { padding: 20px; display: grid; gap: 12px; border: 0; box-shadow: inset 0 0 0 1px var(--line); }
@media (max-width: 400px) { .sheet { padding: 20px 16px; } }

/* the one thing that waits on them: the people colour, and the only primary button on the page */
.card.turn { box-shadow: inset 0 0 0 1.5px var(--accent-line); }
.turn-eye { color: var(--accent-ink); }
.turn .btn { justify-self: start; }

.apps { display: grid; gap: 12px; }
.app-head { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 12px; flex-wrap: wrap; }
.app-head h3 { min-width: 0; overflow-wrap: anywhere; }
.when { font-size: var(--t-sm); color: var(--ink-3); }
.line { font-size: var(--t-sm); color: var(--ink-2); }
.line a { margin-left: 4px; }

/* progress: one segment per candidate step; done in ink, now in the accent, the rest waiting */
.bar { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 4px; }
.bar li { display: grid; gap: 6px; min-width: 0; }
.seg { height: 6px; border-radius: 9px; background: var(--line); }
.lbl { font-size: var(--t-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.done .seg { background: var(--ink); }
.done .lbl { color: var(--ink-2); }
.now .seg { background: var(--accent); }
.now .lbl { color: var(--ink); font-weight: 600; }

.welcome { padding: 24px 20px; }
.welcome .chip, .welcome .btn { justify-self: start; }
.ended { padding: 20px; display: grid; gap: 8px; border-radius: var(--r-card); background: var(--sunk); }
.ended .when { color: var(--ink-2); }

.updates { display: grid; gap: 10px; }
.updates h2 { font-size: var(--t-lg); }
.updates ul { list-style: none; margin: 0; padding: 0; border-radius: var(--r-panel); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.updates li + li { border-top: 1px solid var(--line); }
summary { padding: 12px 14px; display: grid; gap: 2px; cursor: pointer; list-style: none; border-radius: var(--r-panel); }
summary::-webkit-details-marker { display: none; }
.u-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.u-top b { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.u-top .chip { flex: none; }
.u-body { padding: 0 14px 14px; white-space: pre-line; font-size: var(--t-sm); color: var(--ink-2); overflow-wrap: anywhere; }
.more { justify-self: start; }
.foot { font-size: var(--t-sm); color: var(--ink-2); }

.ask { display: grid; gap: 12px; }
.ask input { min-height: var(--h-lg); font-size: var(--t-lg); }
.ask .btn { justify-self: start; }
.sent h2 { font-size: var(--t-lg); }

/* the wait: the boot screen's badge, same size, swing and reader light, from the same moment */
.wait { min-height: 70dvh; display: grid; place-content: center; justify-items: center; gap: 18px; animation: appear 240ms ease-out var(--delay) both; }
.wait p { font-size: 15px; font-weight: 500; color: var(--ink-2); }
.hang { display: grid; justify-items: center; transform-origin: 50% 0; animation: present 1s var(--ease) var(--delay) both; }
.strap { width: 2px; height: 44px; margin-bottom: -18px; border-radius: 2px; background: color-mix(in oklch, var(--ink) 35%, transparent); }
.badge { position: relative; width: 56px; height: 68px; border-radius: 16px; overflow: hidden; background: var(--ink); box-shadow: 0 8px 24px oklch(0.3 0.04 330 / 0.18); }
.badge::before { content: ""; position: absolute; z-index: 1; top: 11px; left: 50%; translate: -50% 0; width: 22px; height: 7px; border-radius: 7px; background: var(--accent); }
.badge::after { content: ""; position: absolute; left: 0; right: 0; top: -10px; height: 10px; opacity: 0; background: linear-gradient(180deg, transparent, oklch(0.98 0 0 / 0.38), transparent); animation: scan 1.8s cubic-bezier(.45, 0, .25, 1) calc(var(--delay) + 0.5s) infinite; }
@keyframes appear { from { opacity: 0; scale: .95; } to { opacity: 1; scale: 1; } }
@keyframes present { 35% { rotate: -6deg; translate: 0 -2px; } 70% { rotate: 3deg; translate: 0 0; } }
@keyframes scan { 0% { top: -10px; opacity: 0; } 15% { opacity: 1; } 65% { top: 68px; opacity: 1; } 66%, 100% { top: 68px; opacity: 0; } }
@keyframes breathe { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) {
  .hang, .badge::after { animation: none; }
  .badge::before { animation: breathe 1.6s ease-in-out infinite !important; animation-duration: 1.6s !important; animation-iteration-count: infinite !important; }
}
</style>
