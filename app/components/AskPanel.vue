<script setup lang="ts">
// Ask: the corner button (same place on every page) and the panel beside the page. Mounted once, in the default layout.
// Drawn in ink, the colour for "the system acts"; magenta stays for people.
const { me, isAdmin, canAsk } = useMe()
const { open, thread, streaming, error, draft, focus, ctx, reading, ask, stop, retry, loadContext, floats } = useAsk()
const MAX = ASK_MAX
const route = useRoute()
const toast = useToast()
const { open: helping } = useHelp()

// AI off: hidden for everyone but admins, who see why and where to turn it on
const show = computed(() => canAsk.value || isAdmin.value)
const panel = ref<HTMLElement>()
const scroller = ref<HTMLElement>()
const corner = ref<HTMLButtonElement>()
const mac = ref(true)
const keys = computed(() => (mac.value ? '⌘J' : 'Ctrl J'))

let returnTo: HTMLElement | null = null
watch(open, async (o) => {
  if (o) {
    returnTo = document.activeElement as HTMLElement | null
    loadContext()
    await nextTick()
    panel.value?.querySelector<HTMLElement>('textarea, [data-first]')?.focus()
  }
  else {
    await nextTick()
    if (helping.value) return // closed because Help opened: Help takes the focus
    ;(returnTo?.isConnected ? returnTo : corner.value)?.focus()
  }
})
// a focus belongs to the page it was set on
watch(() => route.path, () => {
  focus.value = null
  if (open.value) loadContext()
})

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j' && show.value) {
    e.preventDefault()
    open.value = !open.value
  }
}
onMounted(() => {
  mac.value = /Mac|iPhone|iPad/.test(navigator.platform)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// while reading, the old page's words would be wrong here, so the generic ones stand in
const placeholder = computed(() => (reading.value ? null : ctx.value?.placeholder) ?? 'Ask about this page')

// the label's first part is the subject: "Ben Okafor · Barista, weekends"
const subject = computed(() => {
  const [head, ...rest] = (ctx.value?.label ?? 'this page').split(' · ')
  return { head, rest: rest.join(' · ') }
})

function send() {
  if (streaming.value) return stop()
  ask(draft.value)
}
function onEnter(e: KeyboardEvent) {
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  send()
}

// each answer read once per change: plain paragraphs, and its sources as chips
const views = computed(() => thread.value.map(t => t.role === 'assistant' ? parseAnswer(t.text, !t.done) : null))

// keep the newest words in view while they arrive, unless the person scrolled up to read
const last = computed(() => thread.value.at(-1))
watch(() => last.value?.text, async () => {
  const s = scroller.value
  if (!s || s.scrollHeight - s.scrollTop - s.clientHeight > 80) return
  await nextTick()
  s.scrollTop = s.scrollHeight
})
watch(() => thread.value.length, async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
})

// screen readers hear the answer once, when it is complete, not every chunk
const said = ref('')
watch(streaming, (s) => {
  const t = last.value
  if (!s && t?.role === 'assistant' && t.done) said.value = parseAnswer(t.text).paras.join(' ')
})

// a source chip takes you to that part of the page and outlines it in ink for 2 seconds
const pointTo = (id: string) => point(id) || toast.show('That part isn’t on this page.')
</script>

<template>
  <template v-if="show && me">
    <!-- in the layout's top-right corner, beside Updates; hidden while Help is open, so it doesn't sit on the help header -->
    <Teleport to="#corner" defer>
      <button v-if="!open && !helping" ref="corner" type="button" class="btn btn-sm corner" :aria-keyshortcuts="mac ? 'Meta+J' : 'Control+J'" @click="open = true">
        <Icon name="ask" :size="16" />Ask<span class="kbd">{{ keys }}</span>
      </button>
    </Teleport>

    <aside v-if="open" ref="panel" class="ask" :class="{ over: floats, working: streaming }" aria-label="Ask" @keydown.esc.stop="open = false">
      <header class="head">
        <div class="title">
          <h2>Ask</h2><span class="kbd" aria-hidden="true">{{ keys }}</span>
        </div>
        <button type="button" class="btn btn-quiet btn-icon btn-sm close" aria-label="Close Ask" :title="`Close (Esc or ${keys})`" @click="open = false">
          <Icon name="x" :size="16" />
        </button>
        <Transition v-if="canAsk" name="turn" mode="out-in">
          <p v-if="reading" key="reading" class="looking"><span class="dot" aria-hidden="true" /><span class="txt">Reading this page…</span></p>
          <p v-else :key="ctx?.label ?? ''" class="looking">
            <Icon v-if="ctx?.scope === 'task'" name="lock" :size="14" class="lock" />
            <span v-else-if="ctx?.initials" class="avatar" aria-hidden="true">{{ ctx.initials }}</span>
            <span class="txt">Looking at <b>{{ subject.head }}</b><template v-if="subject.rest"> · {{ subject.rest }}</template></span>
          </p>
        </Transition>
      </header>

      <!-- AI is off or not set up: only admins get here -->
      <div v-if="!canAsk" class="off">
        <h3>{{ me.ai === 'off' ? 'AI is off' : 'AI isn’t set up yet' }}</h3>
        <p v-if="me.ai === 'off'" class="muted">Turn on Use AI in Settings to ask about candidates, explain scores and run AI steps. Until then, nobody else sees Ask.</p>
        <p v-else class="muted">The server has no AI key. Add <code>GEMINI_API_KEY</code> to the server, then turn on Use AI in Settings. Until then, nobody else sees Ask.</p>
        <NuxtLink to="/settings" class="btn btn-sm btn-dark" data-first>Open Settings</NuxtLink>
      </div>

      <template v-else>
        <div ref="scroller" class="thread">
          <div v-if="!thread.length" class="empty-ask">
            <h3>{{ placeholder }}</h3>
            <!-- the shape of the suggestions that are coming, not grey blocks -->
            <ul v-if="reading" class="sugg wait" aria-hidden="true">
              <li v-for="w in [64, 78, 52]" :key="w"><span class="row"><span class="skeleton" :style="{ width: `${w}%` }" /></span></li>
            </ul>
            <TransitionGroup v-else-if="ctx?.suggestions.length" tag="ul" name="turn" appear class="sugg" aria-label="Suggested questions">
              <li v-for="(s, n) in ctx.suggestions" :key="s" :style="{ transitionDelay: `${n * 50}ms` }">
                <button type="button" @click="ask(s)">{{ s }}<Icon name="arrow-right" :size="16" /></button>
              </li>
            </TransitionGroup>
          </div>

          <TransitionGroup tag="div" name="turn" class="turns">
          <template v-for="(t, i) in thread" :key="i">
            <p v-if="t.role === 'divider'" class="divider">{{ t.text }}</p>
            <p v-else-if="t.role === 'user'" class="q">{{ t.text }}</p>
            <div v-else class="a">
              <p v-for="(p, n) in views[i]!.paras" :key="n">{{ p }}<span v-if="!t.done && n === views[i]!.paras.length - 1" class="typing" aria-hidden="true" /></p>
              <p v-if="!views[i]!.paras.length"><span class="typing" aria-hidden="true" /><span class="sr-only">Writing</span></p>
              <Transition name="turn">
                <ul v-if="t.done && views[i]!.cites.length" class="srcs" aria-label="Sources">
                  <li v-for="c in views[i]!.cites" :key="c.id">
                    <button type="button" class="src" @click="pointTo(c.id)">{{ c.label }}</button>
                  </li>
                </ul>
              </Transition>
            </div>
          </template>
          </TransitionGroup>

          <div v-if="error" class="err" role="alert">
            <p>{{ error }} Your question is still in the box.</p>
            <button type="button" class="btn btn-sm" @click="retry"><Icon name="retry" :size="14" />Try again</button>
          </div>
        </div>

        <p class="sr-only" aria-live="polite">{{ said }}</p>

        <form class="compose" @submit.prevent="send">
          <div class="box">
            <label for="ask-q" class="sr-only">Your question</label>
            <textarea
              id="ask-q" v-model="draft" rows="1" :maxlength="MAX" :placeholder="placeholder"
              @keydown.enter="onEnter"
            />
            <button v-if="streaming" type="button" class="send stop" aria-label="Stop the answer" @click="stop">
              <Icon name="halt" :size="16" />
            </button>
            <button v-else type="submit" class="send" aria-label="Send" :disabled="!draft.trim()">
              <Icon name="arrow-up" :size="16" />
            </button>
          </div>
          <p class="foot">
            <span>Reads only what you can see here. Check the sources.</span>
            <span v-if="draft.length > MAX - 100" class="count">{{ draft.length }} / {{ MAX }}</span>
          </p>
        </form>
      </template>
    </aside>
  </template>
</template>

<style scoped>
/* the corner pill: in the layout's fixed top-right corner, above each page's own actions */
.corner { box-shadow: inset 0 0 0 1px var(--line-2), var(--shadow-1); }
.corner .kbd { margin-left: 2px; }

/* docked beside <main> from 1280 px (the shell gives it a column); below that it lies over the right edge, with no backdrop */
.ask {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 30; width: 392px;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto;
  grid-template-columns: minmax(0, 1fr); /* else the column grows to the one-line "Looking at …" and spills off-screen */
  background: var(--surface); border-left: 1px solid var(--line); box-shadow: var(--shadow-3);
}
@media (min-width: 1280px) {
  .ask:not(.over) { position: sticky; bottom: auto; align-self: start; height: 100dvh; width: auto; box-shadow: -16px 0 32px -24px oklch(0.3 0.04 330 / 0.25); }
}
/* opens from the corner button's side; closing is instant, the person is done with it */
.ask { animation: ask-in var(--t-move) var(--ease); }
@keyframes ask-in { from { opacity: 0; translate: 16px 0; } }
/* the badge slot: ink, because the system answers */
.ask::before { content: ""; position: absolute; top: 9px; left: 50%; translate: -50% 0; width: 30px; height: 5px; border-radius: 9px; background: var(--machine); }
/* while the system writes, the reader light of the boot check-in runs along its slot */
.ask.working::before {
  background: linear-gradient(90deg, var(--machine) 0 35%, oklch(0.7 0.02 330) 50%, var(--machine) 65% 100%) 0 0 / 300% 100%;
  animation: sweep 1.2s cubic-bezier(.45, 0, .25, 1) infinite;
}
@keyframes sweep { from { background-position: 100% 0; } to { background-position: 0 0; } }

/* new things arrive from just below: the chip, suggestions, each turn, the sources */
.turn-enter-active { transition: opacity var(--t-move) var(--ease), translate var(--t-move) var(--ease); }
.turn-leave-active { transition: opacity var(--t-micro) ease-in; }
.turn-enter-from { opacity: 0; translate: 0 6px; }
.turn-leave-to { opacity: 0; }
.turns { display: grid; gap: 16px; }
.turns:empty { display: none; }

.head { padding: 24px 18px 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; border-bottom: 1px solid var(--line); }
.title { display: flex; align-items: center; gap: 8px; min-height: 30px; padding-right: 40px; }
.title h2 { font-size: var(--t-lg); }
/* the close button takes the corner pill's place, so open and close are one spot */
.close { position: absolute; top: 14px; right: 16px; width: var(--h-sm); }
.looking { display: flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%; min-height: 34px; padding: 6px 12px 6px 6px; border-radius: var(--r-pill); background: var(--sunk); font-size: var(--t-sm); }
.looking .avatar { --size: 22px; font-size: 9px; }
.looking .lock { margin-left: 4px; color: var(--ink-2); }
.looking .txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.looking b { font-weight: 600; }
.dot { display: grid; place-items: center; width: 22px; height: 22px; flex: none; }
.dot::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--machine); animation: breathe 1.2s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.35; } }
/* reduced motion keeps the breathing, slower, so reading never looks idle */
@media (prefers-reduced-motion: reduce) { .dot::before { animation: breathe 1.6s ease-in-out infinite !important; } }

.thread { overflow-y: auto; overscroll-behavior: contain; padding: 18px; display: grid; align-content: start; gap: 16px; }
.empty-ask { display: grid; gap: 14px; padding-top: 6px; }
.empty-ask h3 { font-size: var(--t-xl); letter-spacing: -0.01em; }
.sugg { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.sugg button {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; border: 0; border-radius: var(--r-panel);
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2); font: 500 var(--t-md) var(--font); color: var(--ink); text-align: left; cursor: pointer;
  transition: background var(--t-micro) var(--ease);
}
.sugg button:hover { background: var(--hover); }
.sugg svg { margin-left: auto; color: var(--ink-3); }
.wait .row { display: flex; align-items: center; height: 44px; padding: 0 14px; border-radius: var(--r-panel); box-shadow: inset 0 0 0 1px var(--line); }
.wait .skeleton { height: 12px; border-radius: 6px; }

.q { justify-self: end; max-width: 86%; padding: 9px 14px; border-radius: 16px 16px 4px 16px; background: var(--ink); color: #fff; font-weight: 500; white-space: pre-line; overflow-wrap: anywhere; }
.a { display: grid; gap: 10px; }
.a p { line-height: 1.55; white-space: pre-line; overflow-wrap: anywhere; }
.typing { display: inline-block; width: 7px; height: 15px; margin-left: 2px; vertical-align: -2px; border-radius: 2px; background: var(--machine); animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .typing { animation: none; } }
.srcs { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.src {
  display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 0; border-radius: var(--r-pill);
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2); font: 600 var(--t-xs) var(--font); color: var(--ink); cursor: pointer;
}
.src:hover { box-shadow: inset 0 0 0 1.5px var(--machine); background: var(--sunk); }
.divider { display: flex; align-items: center; gap: 10px; font-size: var(--t-xs); font-weight: 600; color: var(--ink-3); }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px dashed var(--line-2); }
.err { display: grid; gap: 8px; justify-items: start; padding: 12px 14px; border-radius: var(--r-panel); background: var(--bad-tint); color: var(--bad); font-size: var(--t-sm); font-weight: 500; }

.compose { padding: 12px 14px 14px; border-top: 1px solid var(--line); display: grid; gap: 8px; }
.box { display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 14px; border: 1px solid var(--line-2); border-radius: 18px; background: var(--surface); }
.box:focus-within { border-color: var(--ink); }
.box textarea:focus-visible { box-shadow: none; } /* the global magenta ring would sit inside the ink border */
.box textarea {
  flex: 1; min-height: 22px; max-height: 120px; padding: 6px 0; border: 0; outline: none; resize: none; background: transparent;
  field-sizing: content; line-height: 1.45; font: inherit; color: var(--ink);
}
.box textarea::placeholder { color: var(--ink-3); }
.send { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 50%; background: var(--ink); color: #fff; cursor: pointer; }
.send:disabled { opacity: 0.35; cursor: default; }
.send.stop { background: var(--surface); color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--ink); }
.send:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.foot { display: flex; justify-content: space-between; gap: 8px; font-size: var(--t-xs); color: var(--ink-3); }
.count { font-variant-numeric: tabular-nums; }

.off { display: grid; gap: 10px; justify-items: start; align-content: start; padding: 18px; }
.off h3 { font-size: var(--t-lg); }
.off code { font: 500 var(--t-xs) var(--mono); }
</style>
