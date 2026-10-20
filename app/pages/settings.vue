<script setup lang="ts">
useHead({ title: 'Settings' })

interface Settings { companyName: string | null, replyToEmail: string | null, consentText: string | null, aiNoticeText: string | null }

const form = reactive({ companyName: '', replyToEmail: '', consentText: '', aiNoticeText: '' })
const loaded = ref(false)
const loadError = ref('')
async function load() {
  loadError.value = ''
  try {
    const s = await api<Settings>('/api/settings')
    Object.assign(form, { companyName: s.companyName ?? '', replyToEmail: s.replyToEmail ?? '', consentText: s.consentText ?? '', aiNoticeText: s.aiNoticeText ?? '' })
    loaded.value = true
  }
  catch (e) { loadError.value = toApiError(e).message }
}
load()

const orNull = (s: string) => s.trim() || null
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
watch(form, () => { saved.value = false })
async function save() {
  saving.value = true
  saveError.value = ''
  try {
    await api('/api/settings', { method: 'PUT', body: { companyName: orNull(form.companyName), replyToEmail: orNull(form.replyToEmail), consentText: orNull(form.consentText), aiNoticeText: orNull(form.aiNoticeText) } })
    saved.value = true
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

    <div v-else-if="!loaded" class="layout">
      <div class="skeleton" style="height: 420px; border-radius: var(--r-panel)" />
      <div class="skeleton" style="height: 260px; border-radius: var(--r-panel)" />
    </div>

    <div v-else class="layout">
      <form class="panel fields" @submit.prevent="save">
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
          <label for="s-ai">AI screening notice</label>
          <textarea id="s-ai" v-model="form.aiNoticeText" rows="3" maxlength="2000" aria-describedby="s-ai-h" />
          <p id="s-ai-h" class="hint">Tells candidates an automated review reads their application. Leave empty to show nothing.</p>
        </div>
        <div class="foot">
          <button class="btn btn-primary" :aria-busy="saving" :disabled="saving"><span v-if="saving" class="spinner" /><span>Save settings</span></button>
          <span aria-live="polite" class="status">
            <span v-if="saved" class="ok"><Icon name="check" :size="16" />Saved</span>
            <span v-else-if="saveError" class="error"><Icon name="alert" :size="16" />{{ saveError }}</span>
          </span>
        </div>
      </form>

      <aside class="preview" aria-labelledby="pv">
        <h2 id="pv" class="eyebrow">Preview · bottom of the apply form</h2>
        <div class="sheet" aria-hidden="true">
          <ApplyNotices :consent-text="orNull(form.consentText)" :ai-notice-text="orNull(form.aiNoticeText)" preview />
          <p v-if="!orNull(form.consentText) && !orNull(form.aiNoticeText)" class="faint none">Nothing extra shows above the button.</p>
          <span class="fake-send">Send application</span>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 400px); gap: 24px; align-items: start; max-width: 1120px; }
.fields { padding: 24px; display: grid; gap: 24px; }
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
</style>
