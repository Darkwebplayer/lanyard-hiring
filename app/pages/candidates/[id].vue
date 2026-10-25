<script setup lang="ts">
import type { Pos } from '~/components/candidate/NextMenu.vue'
import { type Run, type Timeline, type TimelineEvent, fmtVal, humanise, stepName } from '~/components/candidate/Trace.vue'

const route = useRoute()
const id = computed(() => route.params.id as string)
const { isManager } = useMe()

const tl = ref<Timeline | null>(null)
const error = ref<ApiError | null>(null)
const loading = ref(true)
async function load() {
  try {
    tl.value = await api<Timeline>(`/api/applications/${id.value}`)
    error.value = null
  }
  catch (e) {
    error.value = e as ApiError
  }
  finally {
    loading.value = false
  }
}
watch(id, () => {
  tl.value = null
  loading.value = true
  load()
}, { immediate: true })

const name = computed(() => (tl.value ? fullName(tl.value.candidate) : ''))
useHead({ title: () => name.value || 'Candidate' })

const app = computed(() => tl.value?.application)
const active = computed(() => app.value?.status === 'active')
const latest = computed(() => tl.value?.runs.at(-1))
// after a move or an answer the next step is often still starting; look again until it settles
// ponytail: fixed 3s × 10 poll, a push channel if pages ever need live updates
let polls = 0
watch(latest, (r) => {
  if (r && ['pending', 'running'].includes(r.status) && polls++ < 10) { const at = id.value; setTimeout(() => at === id.value && load(), 3000) }
  else if (r && !['pending', 'running'].includes(r.status)) polls = 0
})
// a worker that died mid-step: the backend calls a run stale after 15 min (claimedAt, which we don't get; createdAt is close)
const stuck = computed(() => latest.value?.status === 'running' && Date.now() - Date.parse(latest.value.createdAt) > 15 * 60_000)
const needsHand = computed(() => active.value && (latest.value?.status === 'failed' || stuck.value))
const hired = computed(() => app.value?.status === 'closed' && app.value.outcome === 'hired')
const closedAt = computed(() => tl.value?.events.findLast(e => e.type === 'closed')?.createdAt ?? latest.value?.completedAt)
const slot = computed(() => {
  if (!active.value) return 'line'
  if (needsHand.value || latest.value?.overdue) return 'bad'
  return latest.value?.status === 'waiting_on_human' ? 'accent' : 'ink'
})

// Managers can add people to a waiting task: everyone who can sign in.
const users = ref<{ id: string, name: string }[] | null>(null)
watchEffect(() => {
  if (users.value || !isManager.value || !tl.value?.runs.some(r => r.status === 'waiting_on_human')) return
  api<{ id: string, name: string }[]>('/api/users/assignable')
    .then(r => users.value = r)
    .catch(() => {}) // the add picker just doesn't show
})

const actionError = ref('')
const retrying = ref(false)
async function retry(run: Run) {
  retrying.value = true
  actionError.value = ''
  try {
    await api(`/api/runs/${run.id}/retry`, { method: 'POST' })
    await load()
  }
  catch (e) {
    actionError.value = (e as ApiError).message
  }
  finally {
    retrying.value = false
  }
}

const moveDlg = ref<{ open: (preset?: Pos | null) => void }>()
const offerRef = ref<{ open: () => void }>()
const flowRef = ref<{ focus: () => void }>()
// the step they wait at with a person on it: the only place a booking can hang
const bookingRun = computed(() => active.value && latest.value?.status === 'waiting_on_human' && latest.value.nodeType === 'human_task' ? latest.value : null)
const badge = ref<HTMLElement>()
async function onMoved(to: { node: string } | { close: string }) {
  actionError.value = ''
  await load()
  // The one Moment: the header turns into a badge, once, right after you close as hired.
  if ('close' in to && to.close === 'hired') {
    await nextTick()
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
    badge.value?.animate(
      calm
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'scale(1.012)', offset: 0.65 }, { transform: 'scale(1)' }],
      { duration: calm ? 200 : 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
  }
}

// Steps and the things people did, in time order (ties: the event first, it caused the step).
const SHOWN = new Set(['manual_move', 'run_retried', 'task_reassigned', 'imported', 'offer_made', 'offer_withdrawn', 'offer_answered', 'booked', 'booking_cancelled'])
const items = computed(() => {
  const t = tl.value
  if (!t) return []
  return [
    ...t.events.filter(e => SHOWN.has(e.type)).map(ev => ({ key: ev.id, at: Date.parse(ev.createdAt), ev, run: null })),
    ...t.runs.map(run => ({ key: run.id, at: Date.parse(run.createdAt), ev: null, run })),
  ].map((x, i) => ({ ...x, i })).sort((a, b) => a.at - b.at || a.i - b.i)
})

function eventText(e: TimelineEvent) {
  const t = tl.value!
  const who = e.actorName ?? 'Someone'
  if (e.type === 'imported') return `${who} imported ${t.candidate.firstName} from a spreadsheet${e.data?.node ? ` at ${stepName(t, e.data.node)}` : ''}`
  if (e.type === 'offer_made') return `${who} made an offer${e.data?.replaced?.length ? ', replacing the earlier one' : ''}`
  if (e.type === 'offer_withdrawn') return `${who} withdrew the offer`
  if (e.type === 'offer_answered') {
    const said = e.data?.accepted ? 'accepted the offer' : 'declined the offer'
    return e.data?.via === 'link' ? `${t.candidate.firstName} ${said} on the link` : `${who} recorded that ${t.candidate.firstName} ${said} ${({ phone: 'on the phone', email: 'by email', in_person: 'in person' } as Record<string, string>)[e.data?.via] ?? ''}`.trim()
  }
  if (e.type === 'booking_cancelled') return `The interview booked for ${fmtBooked(e.data?.startsAt)} was cancelled`
  if (e.type === 'booked') {
    const r = t.runs.find(x => x.id === e.data?.runId)
    const was = e.data?.previous ? `, moved from ${fmtDateTime(e.data.previous)}` : ''
    return `${t.candidate.firstName} booked ${r ? stepName(t, r.nodeKey) : 'a time'} for ${fmtBooked(e.data?.startsAt)}${was}`
  }
  if (e.type === 'manual_move') {
    if (e.data?.to?.close) return `${who} closed this as ${e.data.to.close}`
    return `${who} ${e.data?.previous?.status === 'closed' ? 'reopened this at' : 'moved this to'} ${stepName(t, e.data?.to?.node ?? '')}`
  }
  const run = t.runs.find(r => r.id === e.data?.runId)
  const step = run ? stepName(t, run.nodeKey) : 'a step'
  if (e.type === 'run_retried') return `${who} retried ${step}`
  const nameOf = (uid: string) => run?.assignments.find(a => a.userId === uid)?.name ?? 'someone'
  const parts = [
    e.data?.add?.length ? `added ${e.data.add.map(nameOf).join(', ')}` : '',
    e.data?.remove?.length ? `removed ${e.data.remove.map(nameOf).join(', ')}` : '',
  ].filter(Boolean)
  return `${who} changed who’s on ${step}: ${parts.join(', ') || 'no change'}`
}

const answers = computed(() => {
  const t = tl.value
  if (!t) return []
  return t.form.map(f => ({ ...f, v: t.application.answers[f.key] }))
})
// A manual move's answers to the stage's questions, labelled from the pinned flow when we have it.
function moveAnswers(e: TimelineEvent) {
  const a = e.data?.answers as Record<string, unknown> | undefined
  if (!a) return []
  const asked = tl.value?.graph?.stages?.flatMap(s => s.ask ?? []) ?? []
  return Object.entries(a).map(([k, v]) => ({ k, label: asked.find(f => f.key === k)?.label ?? humanise(k), v: fmtVal(v) }))
}

// Where they came from, as the recruiter would say it. Sources are free text from ?src= links.

const fileUrl = (key: string) => `/api/applications/${id.value}/files/${key}`
const isUrl = (v: unknown) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v)
</script>

<template>
  <div class="page">
    <div v-if="loading" class="skel" aria-busy="true" aria-label="Loading candidate">
      <div class="skeleton" style="height: 14px; width: 200px; margin: 3px 0 11px" />
      <div class="skeleton" style="height: 128px; border-radius: var(--r-card)" />
      <div class="cols">
        <div class="stack">
          <div class="skeleton" style="height: 180px; border-radius: var(--r-card)" />
          <div v-for="n in 5" :key="n" class="skeleton" style="height: 36px" />
        </div>
        <div class="skeleton" style="height: 260px; border-radius: var(--r-panel)" />
      </div>
    </div>

    <div v-else-if="error?.status === 404" class="empty">
      <Icon name="search" :size="28" />
      <h1>Candidate not found</h1>
      <p>This candidate doesn’t exist, or isn’t yours to see.</p>
      <NuxtLink to="/inbox" class="btn">Go to your inbox</NuxtLink>
    </div>

    <div v-else-if="error" class="empty" role="alert">
      <Icon name="alert" :size="28" />
      <h1>Couldn’t load this candidate</h1>
      <p>{{ error.message }}</p>
      <button class="btn" @click="loading = true; load()"><Icon name="retry" />Retry</button>
    </div>

    <template v-else-if="tl && app">
      <NuxtLink v-if="isManager" :to="`/jobs/${tl.job.id}`" class="crumb"><Icon name="chevron-left" :size="14" />{{ tl.job.title }} · Pipeline</NuxtLink>
      <NuxtLink v-else to="/inbox" class="crumb"><Icon name="chevron-left" :size="14" />Inbox</NuxtLink>
      <header v-if="!hired" class="head card" :data-slot="slot">
        <Avatar :name="name" :size="56" />
        <div class="who">
          <h1>{{ name }}</h1>
          <p class="meta">
            <NuxtLink v-if="isManager" :to="`/jobs/${tl.job.id}`">{{ tl.job.title }}</NuxtLink><span v-else>{{ tl.job.title }}</span>
            <span class="sep">·</span>Applied {{ fmtDate(app.createdAt) }}<span class="sep">·</span>flow v{{ tl.version }}
          </p>
          <p class="contact">
            <a :href="`mailto:${tl.candidate.email}`">{{ tl.candidate.email }}</a>
            <template v-if="tl.candidate.phone"><span class="sep">·</span><a :href="`tel:${tl.candidate.phone}`">{{ tl.candidate.phone }}</a></template>
          </p>
        </div>
        <div class="state">
          <div v-if="active && app.currentNodeKey" class="now">
            <RunStatus v-if="latest" :status="stuck ? 'failed' : latest.status" :overdue="latest.overdue" />
            <CandidateNextMenu
              v-if="isManager && tl.graph" :tl="tl" :graph="tl.graph" :at="app.currentNodeKey"
              @pick="to => moveDlg?.open(to)" @flow="flowRef?.focus()"
            />
            <p v-else><span class="muted">At</span> <b>{{ stepName(tl, app.currentNodeKey) }}</b></p>
          </div>
          <span v-else-if="app.outcome" class="chip big" :class="OUTCOME[app.outcome]?.chip">{{ OUTCOME[app.outcome]?.text ?? humanise(app.outcome) }}</span>
          <div v-if="isManager" class="actions">
            <button v-if="needsHand && latest" class="btn" :disabled="retrying" :aria-busy="retrying" @click="retry(latest)">
              <span v-if="retrying" class="spinner" /><Icon v-else name="retry" />Retry
            </button>
            <button v-if="active" type="button" class="btn" @click="offerRef?.open()">
              <Icon name="mail" />Make offer…
            </button>
            <button v-if="!active || !tl.graph" class="btn" :class="{ 'btn-primary': needsHand }" @click="moveDlg?.open()">
              <Icon :name="active ? 'move' : 'reopen'" />{{ active ? 'Move to…' : 'Reopen…' }}
            </button>
          </div>
        </div>
      </header>
      <p v-if="actionError" class="form-error top" role="alert"><Icon name="alert" :size="16" />{{ actionError }}</p>

      <div class="cols">
        <div class="stack">
          <div v-if="hired || isManager" class="lead">
            <header v-if="hired" ref="badge" class="badge card">
              <Avatar :name="name" :size="96" />
              <h1>{{ name }}</h1>
              <p class="bjob">
                <NuxtLink v-if="isManager" :to="`/jobs/${tl.job.id}`">{{ tl.job.title }}</NuxtLink><span v-else>{{ tl.job.title }}</span>
              </p>
              <p class="hired"><Icon name="check" :size="16" />Hired · {{ fmtDate(closedAt) }}</p>
              <p class="bcontact">
                <a :href="`mailto:${tl.candidate.email}`">{{ tl.candidate.email }}</a>
                <a v-if="tl.candidate.phone" :href="`tel:${tl.candidate.phone}`">{{ tl.candidate.phone }}</a>
              </p>
              <p class="faint bmeta">Applied {{ fmtDate(app.createdAt) }} · flow v{{ tl.version }}</p>
              <button v-if="isManager" class="btn btn-quiet btn-sm" @click="moveDlg?.open()"><Icon name="reopen" />Reopen…</button>
            </header>
            <CandidateWhy v-if="isManager" :tl="tl" class="why" />
          </div>

          <CandidateOffer v-if="isManager" ref="offerRef" :tl="tl" @changed="load" />

          <section aria-labelledby="steps-h">
            <h2 id="steps-h" class="sec">Steps</h2>
            <ol class="timeline">
              <template v-for="it in items" :key="it.key">
                <CandidateStep
                  v-if="it.run" :tl="tl" :run="it.run" :latest="it.run === latest" :manager="isManager"
                  :users="users" :retrying="retrying" @retry="retry(it.run)" @changed="load"
                />
                <li v-else-if="it.ev" class="event">
                  <span class="edot" aria-hidden="true" />
                  <div>
                    <p><Avatar :name="it.ev.type === 'booked' || it.ev.data?.via === 'link' ? name : it.ev.actorName" :size="20" /> <span>{{ eventText(it.ev) }}</span> <time class="when" :datetime="it.ev.createdAt">{{ fmtDateTime(it.ev.createdAt) }}</time></p>
                    <p v-if="it.ev.data?.reasonCode || it.ev.data?.reason || it.ev.data?.note" class="reason">
                      <b v-if="it.ev.data?.reasonCode">{{ it.ev.data.reasonCode }}</b><template v-if="it.ev.data?.reasonCode && (it.ev.data?.reason || it.ev.data?.note)"> · </template><template v-if="it.ev.data?.reason || it.ev.data?.note">“{{ it.ev.data.reason || it.ev.data.note }}”</template>
                    </p>
                    <dl v-if="moveAnswers(it.ev).length" class="ev-answers">
                      <div v-for="a in moveAnswers(it.ev)" :key="a.k"><dt>{{ a.label }}</dt><dd>{{ a.v }}</dd></div>
                    </dl>
                  </div>
                </li>
              </template>
            </ol>
            <p v-if="!items.length" class="muted">Nothing has happened yet. The first step starts in a moment.</p>
          </section>
        </div>

        <aside class="side">
          <CandidateBooking v-if="bookingRun" :run-id="bookingRun.id" :first-name="tl.candidate.firstName" />
          <CandidateDocuments :application-id="app.id" :first-name="tl.candidate.firstName" :stamp="tl" @changed="load" />
          <CandidateEmails :tl="tl" />
          <CandidateFlowPanel v-if="isManager && tl.graph" ref="flowRef" :tl="tl" :graph="tl.graph" />
          <section class="panel answers" aria-labelledby="ans-h">
            <h2 id="ans-h" class="sec">Application</h2>
            <dl v-if="answers.length">
              <div v-for="f in answers" :key="f.key" :data-ask="`field:${f.key}`">
                <dt>{{ f.label }}</dt>
                <dd v-if="f.type === 'file' && f.v">
                  <a :href="fileUrl(f.key)" download class="file"><Icon name="download" :size="16" /><span>{{ f.v.name ?? 'Download' }}</span></a>
                </dd>
                <dd v-else-if="isUrl(f.v)"><a :href="f.v" target="_blank" rel="noopener" class="ext">{{ String(f.v).replace(/^https?:\/\/(www\.)?/, '') }}</a></dd>
                <dd v-else-if="f.type === 'text' && f.v" class="long">{{ f.v }}</dd>
                <dd v-else :class="{ faint: f.v == null || f.v === '' }">{{ f.v == null || f.v === '' ? 'Not answered' : fmtVal(f.v) }}</dd>
              </div>
            </dl>
            <p v-else class="muted">This job’s form only asks for contact details.</p>
            <div v-if="app.source || app.consent" class="prov">
              <p v-if="app.source">Source: {{ sourceLabel(app.source) }}</p>
              <p v-if="app.consent">Agreed to “{{ app.consent.text }}” on {{ fmtDate(app.consent.at) }}</p>
              <p v-else-if="app.source === 'import'">Imported, so consent wasn’t collected</p>
            </div>
          </section>
        </aside>
      </div>

      <CandidateMoveDialog v-if="isManager" ref="moveDlg" :tl="tl" @moved="onMoved" />
    </template>
  </div>
</template>

<style scoped>
.skel { display: grid; gap: 24px; }
.empty h1 { color: var(--ink); }
.stack { display: grid; gap: 28px; align-content: start; min-width: 0; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) clamp(260px, 24vw, 340px); gap: 24px; align-items: start; }

.head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px 20px; align-items: center; padding: 28px 24px 22px; margin-bottom: 24px; }
.who { min-width: 0; display: grid; gap: 4px; }
.who h1 { overflow-wrap: anywhere; }
.meta, .contact { color: var(--ink-2); }
.contact a { color: var(--ink-2); }
.contact a:hover { color: var(--accent-ink); }
.sep { margin: 0 8px; color: var(--ink-3); }
.state { display: grid; justify-items: end; gap: 12px; }
.now { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.big { height: 28px; padding: 0 12px; font-size: var(--t-sm); }
.actions { display: flex; gap: 8px; }
.top { margin: -12px 0 20px; }
@media (max-width: 1180px) {
  .head { grid-template-columns: auto minmax(0, 1fr); }
  .state { grid-column: 2; justify-items: start; }
  .now { justify-content: flex-start; }
}

.lead { display: flex; flex-wrap: wrap; gap: 24px; align-items: stretch; }
.lead > .why { flex: 1 1 380px; }
/* The hired header drawn as the ID badge itself: an ink band like the brand mark, a slot punched through it
   (the page shows through), the photo spot overlapping the band's edge. */
.badge {
  flex: 0 0 300px; display: grid; justify-items: center; align-content: start; gap: 6px; text-align: center;
  padding: 0 24px 20px; overflow: hidden;
}
.badge::before { content: ""; position: absolute; inset: 0 0 auto; height: 92px; background: var(--ink); }
.badge::after { content: ""; position: absolute; top: 16px; left: 50%; translate: -50% 0; width: 40px; height: 9px; border-radius: 9px; background: var(--bg); box-shadow: inset 0 1px 2px oklch(0.2 0.02 330 / 0.35); }
.badge > * { position: relative; }
.badge .avatar { margin-top: 44px; background: var(--ok-tint); color: var(--ok); box-shadow: 0 0 0 5px var(--surface); }
.badge h1 { margin-top: 10px; overflow-wrap: anywhere; }
.bjob { color: var(--ink-2); font-weight: 500; }
.hired { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; padding: 6px 14px; border-radius: var(--r-pill); background: var(--ok-tint); color: var(--ok); font-weight: 700; }
.bcontact { display: grid; gap: 2px; margin-top: 10px; font-size: var(--t-sm); overflow-wrap: anywhere; }
.bcontact a { color: var(--ink-2); }
.bmeta { font-size: var(--t-sm); }
.badge .btn { margin-top: 6px; }

.sec { font-size: var(--t-lg); margin-bottom: 14px; }
.timeline { list-style: none; margin: 0; padding: 0; position: relative; display: grid; }
.timeline::before { content: ""; position: absolute; left: 15.5px; top: 16px; bottom: 16px; width: 1px; background: var(--line-2); }
.event { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 4px 0 12px; }
.edot { justify-self: center; margin-top: 8px; width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); box-shadow: 0 0 0 4px var(--bg); position: relative; }
.event p:first-child { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 8px; font-size: var(--t-sm); }
.event .when { color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.event .avatar { margin-top: 0; }
.reason { margin: 4px 0 0 28px; font-size: var(--t-sm); padding-left: 12px; border-left: 2px solid var(--accent-line); max-width: 70ch; }

.side { position: sticky; top: 24px; display: grid; gap: 16px; min-width: 0; }
.answers { padding: 18px 18px 8px; }
.answers .sec { margin-bottom: 8px; }
dl { margin: 0; }
dl > div { padding: 10px 0; border-top: 1px solid var(--line); display: grid; gap: 2px; }
dt { font-size: var(--t-xs); color: var(--ink-2); font-weight: 500; }
dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.long { white-space: pre-line; }
.file { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; min-width: 0; }
.file span { overflow-wrap: anywhere; }
.file svg { flex: none; }
/* where they came from and what they agreed to: true, rarely needed, so quiet and last */
.prov { border-top: 1px solid var(--line); padding: 10px 0; display: grid; gap: 4px; font-size: var(--t-xs); color: var(--ink-2); overflow-wrap: anywhere; }
/* answers to the stage's questions: under the quote, aligned with its text, no second rule */
.ev-answers { margin: 4px 0 0 42px; display: grid; gap: 2px; font-size: var(--t-sm); }
.ev-answers div { display: flex; gap: 6px; padding: 0; border: 0; }
.ev-answers dt { font-size: var(--t-sm); }
.ev-answers dt::after { content: ":"; }
</style>
