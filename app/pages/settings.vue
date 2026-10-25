<script setup lang="ts">
useHead({ title: 'Settings' })

interface Settings {
  companyName: string | null, replyToEmail: string | null, consentText: string | null, aiNoticeText: string | null
  aiEnabled: boolean, careersIntro: string | null, rejectReasons: string[]
}

const form = reactive({ companyName: '', replyToEmail: '', consentText: '', aiNoticeText: '', aiEnabled: true, careersIntro: '' })
// each reason keeps a stable id so inputs keep focus while the list reorders
let seq = 0
const reasons = ref<{ id: number, text: string }[]>([])
const loaded = ref(false)
const loadError = ref('')
async function load() {
  loadError.value = ''
  try {
    const s = await api<Settings>('/api/settings')
    Object.assign(form, { companyName: s.companyName ?? '', replyToEmail: s.replyToEmail ?? '', consentText: s.consentText ?? '', aiNoticeText: s.aiNoticeText ?? '', aiEnabled: s.aiEnabled, careersIntro: s.careersIntro ?? '' })
    reasons.value = s.rejectReasons.map(text => ({ id: seq++, text }))
    loaded.value = true
  }
  catch (e) { loadError.value = toApiError(e).message }
}
load()

const origin = import.meta.client ? location.origin : ''
const feedUrl = `${origin}/feeds/jobs.xml`
const feedCopied = ref<boolean | 'failed'>(false)
async function copyFeed() {
  feedCopied.value = (await copyText(feedUrl)) || 'failed'
  setTimeout(() => (feedCopied.value = false), feedCopied.value === 'failed' ? 4000 : 2000)
}

// ---------- reject reasons ----------
const newReason = ref('')
const reasonList = ref<HTMLElement>()
// the same text twice (ignoring case) is one reason to whoever picks from the list
const dupes = computed(() => {
  const seen = new Map<string, number>()
  const out = new Set<number>()
  for (const r of reasons.value) {
    const k = r.text.trim().toLowerCase()
    if (!k) continue
    if (seen.has(k)) out.add(r.id)
    else seen.set(k, r.id)
  }
  return out
})
const reasonProblem = computed(() =>
  reasons.value.some(r => !r.text.trim()) ? 'A reason is empty. Write it or remove it.'
  : dupes.value.size ? 'Two reasons say the same thing. Change or remove one.'
  : !reasons.value.length ? 'Keep at least one reason: rejecting someone needs one.'
  : '')
function addReason() {
  const text = newReason.value.trim()
  if (!text || reasons.value.length >= 20) return
  reasons.value.push({ id: seq++, text })
  newReason.value = ''
}
function moveReason(i: number, by: -1 | 1) {
  const list = reasons.value
  const [r] = list.splice(i, 1)
  list.splice(i + by, 0, r!)
  // keep focus on the button that moved, so pressing it again keeps moving the same reason
  nextTick(() => reasonList.value?.querySelector<HTMLElement>(`[data-r="${r!.id}"] [data-dir="${by}"]`)?.focus())
}
function removeReason(i: number) {
  reasons.value.splice(i, 1)
  nextTick(() => reasonList.value?.querySelectorAll<HTMLInputElement>('input')[Math.max(i - 1, 0)]?.focus())
}

// ---------- save ----------
const orNull = (s: string) => s.trim() || null
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
watch([form, reasons], () => { saved.value = false }, { deep: true })
async function save() {
  if (reasonProblem.value) {
    saveError.value = reasonProblem.value
    return
  }
  saving.value = true
  saveError.value = ''
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: {
        companyName: orNull(form.companyName), replyToEmail: orNull(form.replyToEmail), consentText: orNull(form.consentText), aiNoticeText: orNull(form.aiNoticeText), aiEnabled: form.aiEnabled,
        careersIntro: orNull(form.careersIntro), rejectReasons: reasons.value.map(r => r.text.trim()),
      },
    })
    saved.value = true
    // Use AI changes who sees Ask: read it again, so the corner button and the panel follow without a reload
    const { me } = useMe()
    me.value = await api<Me>('/api/me').catch(() => me.value)
  }
  catch (e) { saveError.value = toApiError(e).message }
  finally { saving.value = false }
}
</script>

<template>
  <div class="page">
    <header class="page-head"><h1>Settings</h1></header>

    <div v-if="loadError" class="empty" role="alert">
      <h2>Settings didn’t load</h2>
      <p>{{ loadError }}</p>
      <button class="btn" @click="load"><Icon name="retry" />Try again</button>
    </div>

    <form v-else class="layout" :aria-busy="!loaded" :inert="!loaded" @submit.prevent="save">
      <div class="col">
        <section class="panel fields" aria-labelledby="h-apply">
          <h2 id="h-apply" class="sect-h">Company and apply form</h2>
          <div class="field">
            <label for="s-company">Company name</label>
            <input id="s-company" v-model="form.companyName" maxlength="200" autocomplete="organization" placeholder="Northwind Logistics" aria-describedby="s-company-h">
            <p id="s-company-h" class="hint">Candidates see it above every job, so they know who they’re applying to.</p>
          </div>
          <div class="field">
            <label for="s-reply">Reply-to email</label>
            <input id="s-reply" v-model="form.replyToEmail" type="email" placeholder="talent@company.com" aria-describedby="s-reply-h">
            <p id="s-reply-h" class="hint">Candidates’ replies and appeals go here. Every email the flows send uses it.</p>
          </div>
          <div class="field">
            <label for="s-consent">Consent text</label>
            <textarea id="s-consent" v-model="form.consentText" rows="4" maxlength="2000" aria-describedby="s-consent-h" />
            <p id="s-consent-h" class="hint">Shown with a checkbox candidates must tick before they can send. Leave empty for no checkbox.</p>
          </div>
          <div class="field">
            <label class="check" for="s-ai-on"><input id="s-ai-on" v-model="form.aiEnabled" type="checkbox" aria-describedby="s-ai-on-h">Use AI</label>
            <p id="s-ai-on-h" class="hint">AI reads CVs, scores answers, explains what is on screen and drafts flows. When off, AI steps stop until you turn it on and retry them, and nobody sees Ask.</p>
          </div>
          <div class="field">
            <label for="s-ai">AI screening notice</label>
            <textarea id="s-ai" v-model="form.aiNoticeText" rows="3" maxlength="2000" aria-describedby="s-ai-h" />
            <p id="s-ai-h" class="hint">Tells candidates an automated review reads their application. Leave empty to show nothing.</p>
          </div>
        </section>

        <section class="panel fields" aria-labelledby="h-careers">
          <div class="sect-top">
            <h2 id="h-careers" class="sect-h">Careers page</h2>
            <a href="/careers" target="_blank" rel="noopener" class="btn btn-sm btn-quiet">Open it<Icon name="external" :size="14" /></a>
          </div>
          <div class="field">
            <label for="s-intro">Intro line</label>
            <textarea id="s-intro" v-model="form.careersIntro" rows="2" maxlength="500" placeholder="We’re a family-run bakery with three shops in Leeds." aria-describedby="s-intro-h" />
            <p id="s-intro-h" class="hint">Sits under your company name, above the list of open jobs. <span class="count">{{ form.careersIntro.length }}/500</span></p>
          </div>
          <div class="field">
            <span class="label" id="s-feed-l">Job feed</span>
            <div class="copy" aria-labelledby="s-feed-l">
              <a :href="feedUrl" target="_blank" rel="noopener" class="url mono">{{ feedUrl }}</a>
              <button type="button" class="btn btn-sm" @click="copyFeed">
                <Icon :name="feedCopied === true ? 'check' : feedCopied ? 'alert' : 'copy'" /><span aria-live="polite">{{ feedCopied === true ? 'Copied' : feedCopied ? 'Select it and copy' : 'Copy link' }}</span>
              </button>
            </div>
            <p class="hint">Give this to job boards such as Indeed. It lists every open job and updates by itself.</p>
          </div>
        </section>

        <section class="panel fields" aria-labelledby="h-reasons">
          <div>
            <h2 id="h-reasons" class="sect-h">Reject reasons</h2>
            <p class="hint">Whoever rejects someone picks one of these. Renaming or removing a reason never changes past decisions: they keep the words they were made with.</p>
          </div>
          <ol ref="reasonList" class="reasons">
            <template v-if="!loaded"><li v-for="i in 3" :key="i" class="skeleton" style="height: var(--h-md)" /></template>
            <li v-for="(r, i) in reasons" :key="r.id" :data-r="r.id" class="reason" :class="{ bad: dupes.has(r.id) || !r.text.trim() }">
              <span class="n faint" aria-hidden="true">{{ i + 1 }}</span>
              <input v-model="r.text" maxlength="60" :aria-label="`Reason ${i + 1}`" :aria-invalid="dupes.has(r.id) || !r.text.trim() || undefined">
              <button type="button" class="btn btn-sm btn-quiet btn-icon" data-dir="-1" :disabled="i === 0" :aria-label="`Move “${r.text}” up`" @click="moveReason(i, -1)"><Icon name="arrow-up" :size="16" /></button>
              <button type="button" class="btn btn-sm btn-quiet btn-icon" data-dir="1" :disabled="i === reasons.length - 1" :aria-label="`Move “${r.text}” down`" @click="moveReason(i, 1)"><Icon name="arrow-down" :size="16" /></button>
              <button type="button" class="btn btn-sm btn-quiet btn-icon" :disabled="reasons.length === 1" :aria-label="`Remove “${r.text}”`" @click="removeReason(i)"><Icon name="x" :size="16" /></button>
            </li>
          </ol>
          <div v-if="reasons.length < 20" class="add">
            <input v-model="newReason" maxlength="60" aria-label="New reason" placeholder="Hired someone else" @keydown.enter.prevent="addReason">
            <button type="button" class="btn btn-sm" :disabled="!newReason.trim()" @click="addReason"><Icon name="plus" />Add reason</button>
          </div>
          <p v-else class="hint">That’s 20, the most the list holds. Remove one to add another.</p>
          <p v-if="loaded && reasonProblem" class="field-error" role="alert"><Icon name="alert" :size="14" />{{ reasonProblem }}</p>
        </section>

        <div class="foot">
          <button class="btn btn-primary" :aria-busy="saving" :disabled="saving"><span v-if="saving" class="spinner" /><span>Save settings</span></button>
          <span aria-live="polite" class="status">
            <span v-if="saved" class="ok"><Icon name="check" :size="16" />Saved</span>
            <span v-else-if="saveError" class="error"><Icon name="alert" :size="16" />{{ saveError }}</span>
          </span>
        </div>
      </div>

      <aside class="preview" aria-labelledby="pv">
        <h2 id="pv" class="eyebrow">Preview · bottom of the apply form</h2>
        <div class="sheet" aria-hidden="true">
          <ApplyNotices :consent-text="orNull(form.consentText)" :ai-notice-text="orNull(form.aiNoticeText)" preview />
          <p v-if="loaded && !orNull(form.consentText) && !orNull(form.aiNoticeText)" class="faint none">Nothing extra shows above the button.</p>
          <span class="fake-send">Send application</span>
        </div>
        <p class="faint aside-note">Your own interview hours are in your <NuxtLink to="/inbox/hours">Inbox</NuxtLink>.</p>
      </aside>
    </form>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 400px); gap: 24px; align-items: start; max-width: 1120px; }
.col { display: grid; gap: 20px; min-width: 0; }
.fields { padding: 24px; display: grid; gap: 24px; }
.sect-h { font-size: var(--t-lg); }
.sect-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sect-top .btn { margin-right: -8px; }
.sect-h + .hint { margin-top: 4px; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }
.count { float: right; font-variant-numeric: tabular-nums; color: var(--ink-3); }
.copy { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 14px; border-radius: var(--r-pill); background: var(--sunk); }
.url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); color: var(--ink); text-decoration: none; }
.url:hover { text-decoration: underline; }

/* reasons: numbered because the order is the order people see them in the reject menu */
.reasons { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.reason { display: grid; grid-template-columns: 20px minmax(0, 1fr) repeat(3, auto); gap: 4px; align-items: center; }
.reason .n { font-size: var(--t-sm); font-variant-numeric: tabular-nums; text-align: right; padding-right: 4px; }
.reason input { margin-right: 4px; }
.add { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-left: 24px; align-items: center; }
.field-error { display: flex; gap: 6px; align-items: center; color: var(--bad); font-size: var(--t-sm); font-weight: 500; }

.foot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.ok, .error { display: inline-flex; gap: 6px; align-items: center; font-weight: 500; font-size: var(--t-sm); }
.ok { color: var(--ok); }
.error { color: var(--bad); }
.preview { position: sticky; top: 24px; display: grid; gap: 10px; }
/* a slice of the candidate page: paper, ink, the one accent on the button */
.sheet { padding: 4px 20px 20px; border-radius: var(--r-panel); background: var(--bg); border: 1px dashed var(--line-2); display: grid; gap: 16px; }
.sheet :deep(.notices) { border-top: 0; }
.sheet :deep(input:checked) { background: var(--ink); border-color: var(--ink); }
.none { padding-top: 16px; font-size: var(--t-sm); }
.fake-send {
  display: grid; place-items: center; height: var(--h-lg); border-radius: var(--r-pill); background: var(--accent); color: #fff;
  font-weight: 600; font-size: var(--t-lg);
}
.aside-note { font-size: var(--t-sm); margin-top: 8px; }
</style>
