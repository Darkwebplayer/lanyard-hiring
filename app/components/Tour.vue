<script setup lang="ts">
// First-run tour: a spotlight on one part of the app at a time, with a small card beside it.
// Targets are [data-tour] attributes; a step with a route goes there first when its target isn't on this page.
interface Step { route?: string, target?: string, title: string, body: string }

const { me, isManager, isAdmin } = useMe()
const { seen, markSeen } = useSeen()
const run = useTour()
const setup = useSetup()
const setupChecked = useSetupChecked()
const route = useRoute()

const EMPLOYEE: Step[] = [
  { title: 'Welcome to Lanyard', body: 'A one-minute look at where your work lives. You can replay this from your avatar menu.' },
  { target: 'inbox', title: 'Your inbox is home', body: 'Everything someone asks you to do lands here. The number shows how many are waiting.' },
  { route: '/inbox', target: 'tasks', title: 'Your tasks', body: 'Click one to open it. Press j and k to move to the next and previous task.' },
  { route: '/inbox', target: 'task', title: 'Fill it in, send it, done', body: 'A task opens here with its scorecard. When you submit one, the next task opens by itself.' },
  { route: '/inbox', target: 'hours', title: 'Set your interview hours', body: 'Candidates can only book an interview with you inside these hours. Without them, nobody can book you.' },
]
const MANAGER: Step[] = [
  { target: 'jobs', title: 'Your jobs', body: 'Every role you’re hiring for, with its candidates and where each one is.' },
  { route: '/jobs', target: 'new-job', title: 'Start a new job', body: 'Name the role, pick how you want to hire, and you get a flow of steps to adjust.' },
  { target: 'library', title: 'Reuse what works', body: 'Steps and whole flows you’ve saved, so the next job starts from them.' },
  { target: 'hires', title: 'See who you hired', body: 'Fill rate per job, and where your applications came from.' },
]
const ADMIN: Step[] = [
  { target: 'team', title: 'Bring your team in', body: 'Invite people and choose their level. The level decides what they can see.' },
  { target: 'settings', title: 'Your company details', body: 'Your apply form, careers page and reject reasons live here.' },
]
const HELP: Step = { target: 'help', title: 'Stuck? Press ? or click Help', body: 'Every page has a help panel with short guides to how things work.' }

const steps = computed(() => [
  ...EMPLOYEE,
  ...(isManager.value ? MANAGER : []),
  ...(isAdmin.value ? ADMIN : []),
  HELP,
])

const i = ref(0)
const step = computed(() => steps.value[i.value]!)
const last = computed(() => i.value === steps.value.length - 1)
const spot = ref<{ left: number, top: number, width: number, height: number } | null>(null)
const pos = ref({ left: 0, top: 0 })
const card = ref<HTMLElement>()
const primary = ref<HTMLButtonElement>()
let el: HTMLElement | null = null
let seq = 0 // a newer step wins over one still waiting for its target
let start = '/inbox'

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// pages render after navigation and data; poll briefly, then give up and centre the card
async function find(sel: string) {
  await nextTick()
  for (let t = 0; t < 20; t++) {
    const e = document.querySelector<HTMLElement>(sel)
    if (e?.getClientRects().length) return e
    await sleep(100)
  }
  return null
}

async function go(n: number) {
  const my = ++seq
  i.value = n
  const s = steps.value[n]!
  let found: HTMLElement | null = null
  if (s.target) {
    const sel = `[data-tour="${s.target}"]`
    if (!document.querySelector(sel) && s.route) await navigateTo(s.route)
    found = await find(sel)
  }
  if (my !== seq || !run.value) return
  el = found
  el?.scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' })
  await nextTick()
  place()
  primary.value?.focus({ preventScroll: true })
}

const PAD = 6 // outline sits just outside the target
const GAP = 16
const EDGE = 16
function place() {
  const vw = innerWidth, vh = innerHeight
  const w = card.value?.offsetWidth ?? 300, h = card.value?.offsetHeight ?? 180
  if (!el) {
    spot.value = null
    pos.value = { left: (vw - w) / 2, top: (vh - h) / 2 }
    return
  }
  const r = el.getBoundingClientRect()
  // tall targets (the task list, the detail pane) get cut to the viewport so the outline stays visible
  const left = Math.max(r.left - PAD, PAD), top = Math.max(r.top - PAD, PAD)
  const right = Math.min(r.right + PAD, vw - PAD), bottom = Math.min(r.bottom + PAD, vh - PAD)
  spot.value = { left, top, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) }
  // right if there's room, else below, else left; then keep it on screen
  let x: number, y: number
  if (right + GAP + w <= vw - EDGE) { x = right + GAP; y = top }
  else if (bottom + GAP + h <= vh - EDGE) { x = left; y = bottom + GAP }
  else { x = left - GAP - w; y = top }
  pos.value = {
    left: Math.min(Math.max(x, EDGE), vw - w - EDGE),
    top: Math.min(Math.max(y, EDGE), vh - h - EDGE),
  }
}

async function finish() {
  markSeen('tour')
  run.value = false
  if (route.fullPath !== start) await navigateTo(start)
}
const next = () => (last.value ? finish() : go(i.value + 1))
const back = () => { if (i.value > 0) go(i.value - 1) }

function onKey(e: KeyboardEvent) {
  const k = ({ Escape: finish, ArrowRight: next, ArrowLeft: back } as Record<string, () => unknown>)[e.key]
  if (!k || e.metaKey || e.ctrlKey || e.altKey) return
  e.preventDefault()
  e.stopPropagation()
  k()
}
const onMove = () => place()

watch(run, (on) => {
  if (on) {
    start = route.fullPath
    pos.value = { left: (innerWidth - 300) / 2, top: innerHeight / 2 - 90 } // near the centre already, so the welcome doesn't slide in from a corner
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true) // capture: the inbox list and others scroll inside themselves
    go(0)
  }
  else {
    seq++
    el = null
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onMove)
    window.removeEventListener('scroll', onMove, true)
  }
})
// the run watcher won't fire once this scope stops, so drop the listeners here too
onBeforeUnmount(() => {
  run.value = false
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onMove)
  window.removeEventListener('scroll', onMove, true)
})

// first visit to the inbox, nothing else open; admins see the setup wizard first, and its last step may start us
function maybeStart() {
  if (run.value || setup.value || !me.value || !route.path.startsWith('/inbox') || route.path === '/inbox/hours') return
  if (seen('tour') || document.querySelector('dialog[open]')) return
  if (isAdmin.value && !seen('setup')) return
  run.value = true
}
onMounted(() => watch([() => route.path, me, setup, setupChecked], maybeStart, { immediate: true }))
</script>

<template>
  <div v-if="run" class="tour">
    <span class="spot" :class="{ none: !spot }" :style="spot ? { left: `${spot.left}px`, top: `${spot.top}px`, width: `${spot.width}px`, height: `${spot.height}px` } : undefined" aria-hidden="true" />
    <div ref="card" class="tcard" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }">
      <span class="count">{{ i + 1 }} of {{ steps.length }}</span>
      <h2 id="tour-title">{{ step.title }}</h2>
      <p id="tour-body">{{ step.body }}</p>
      <div class="foot">
        <span class="dots" aria-hidden="true"><span v-for="(_, k) in steps" :key="k" :class="{ on: k === i }" /></span>
        <span class="acts">
          <button v-if="!last" type="button" class="btn btn-sm btn-quiet" @click="finish">Skip</button>
          <button v-if="i > 0" type="button" class="btn btn-sm" @click="back">Back</button>
          <button ref="primary" type="button" class="btn btn-sm btn-primary" @click="next">{{ i === 0 ? 'Show me' : last ? 'Done' : 'Next' }}</button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* the layer takes every click so only the card is interactive */
.tour { position: fixed; inset: 0; z-index: 60; }
.spot {
  position: fixed; border-radius: var(--r-panel); pointer-events: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 9999px oklch(0.24 0.018 330 / 0.5);
  transition: left var(--t-move) var(--ease), top var(--t-move) var(--ease), width var(--t-move) var(--ease), height var(--t-move) var(--ease);
}
.spot::after { content: ""; position: absolute; inset: -6px; border-radius: 18px; border: 2px solid var(--accent); animation: ping 1.8s var(--ease) infinite; }
/* no target: a zero-size spot in the middle, so the dim stays and the next step grows out of it */
.spot.none { left: 50%; top: 50%; width: 0; height: 0; box-shadow: 0 0 0 9999px oklch(0.24 0.018 330 / 0.5); }
.spot.none::after { display: none; }
@keyframes ping { 0% { opacity: 0.8; scale: 1; } 100% { opacity: 0; scale: 1.06; } }

.tcard {
  position: fixed; width: min(300px, calc(100vw - 32px)); display: grid; gap: 10px; padding: 18px;
  background: var(--surface); color: var(--ink); border-radius: var(--r-panel); box-shadow: var(--shadow-3);
  transition: left var(--t-move) var(--ease), top var(--t-move) var(--ease);
}
.tcard::before { content: ""; position: absolute; top: 0; left: 50%; translate: -50% 0; width: 28px; height: 4px; border-radius: 0 0 4px 4px; background: var(--accent); }
.count { font-size: var(--t-sm); font-weight: 600; color: var(--ink-3); }
.tcard h2 { margin: 0; font-size: var(--t-xl); }
.tcard p { margin: 0; color: var(--ink-2); }
.foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; }
.acts { display: flex; gap: 6px; }
.dots { display: flex; gap: 4px; }
.dots span { width: 6px; height: 6px; border-radius: 3px; background: var(--line-2); }
.dots span.on { width: 16px; background: var(--ink); }

@media (prefers-reduced-motion: reduce) {
  .spot, .tcard { transition: none; }
  .spot::after { animation: none; display: none; }
}
</style>
