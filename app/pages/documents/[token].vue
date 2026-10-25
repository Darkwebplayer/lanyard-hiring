<script setup lang="ts">
definePageMeta({ layout: 'bare' })

interface Docs {
  companyName: string | null, candidateFirstName: string, jobTitle: string, open: boolean
  documents: { label: string, required: boolean, received: boolean, fileName: string | null }[]
}

const MAX_BYTES = 10 * 1024 * 1024
const token = useRoute().params.token as string
const base = `/api/public/documents/${encodeURIComponent(token)}`
const d = ref<Docs | null>(null)
const loadError = ref<{ status: number, message: string } | null>(null)
async function load() {
  loadError.value = null
  try {
    d.value = await api<Docs>(base)
  }
  catch (e) {
    const err = toApiError(e)
    loadError.value = { status: err.status, message: err.message }
  }
}
onMounted(load)
useHead({ title: () => (d.value ? `Documents · ${d.value.jobTitle}` : 'Documents') })

const required = computed(() => d.value?.documents.filter(x => x.required) ?? [])
const sent = computed(() => required.value.filter(x => x.received).length)

const busy = ref<number | null>(null)
const errors = ref<Record<number, string>>({})
async function upload(i: number, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // picking the same file again still fires change
  if (!file) return
  delete errors.value[i]
  if (file.size > MAX_BYTES) {
    errors.value[i] = `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB; try a smaller photo or a PDF.`
    return
  }
  const fd = new FormData()
  fd.set('index', String(i))
  fd.set('file', file)
  busy.value = i
  try {
    await api(base, { method: 'POST', body: fd })
    await load()
  }
  catch (err) {
    const x = toApiError(err)
    errors.value[i] = x.status === 413 ? 'That file is over 10 MB. Try a smaller photo or a PDF.' : x.message
    if (x.code === 'application_closed') await load()
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <main class="docs">
    <p v-if="d?.companyName" class="brand"><span class="mono-mark" aria-hidden="true">{{ d.companyName[0]!.toUpperCase() }}</span><b>{{ d.companyName }}</b></p>

    <div v-if="loadError?.status === 404" class="card sheet">
      <h1>This link doesn’t work</h1>
      <p class="muted">It may be mistyped. Reply to the email that brought you here and ask for a new one.</p>
    </div>

    <div v-else-if="loadError" class="card sheet" role="alert">
      <h1>This page didn’t load.</h1>
      <p class="muted">{{ loadError.message }}</p>
      <button class="btn" @click="load">Try again</button>
    </div>

    <div v-else-if="!d" class="card sheet" aria-busy="true">
      <div class="skeleton" style="height: 30px; width: 80%" />
      <div class="skeleton" style="height: 16px; width: 55%" />
      <div class="skeleton" style="height: 160px" />
    </div>

    <div v-else-if="!d.open" class="card sheet">
      <h1>This link is closed</h1>
      <p class="muted">Your application has finished, so no more documents can be sent here. Reply to the email from {{ d.companyName ?? 'the team' }} if you need to send something.</p>
    </div>

    <section v-else class="card sheet" aria-labelledby="dc-h">
      <div>
        <h1 id="dc-h">Welcome, {{ d.candidateFirstName }}. A few documents before you start.</h1>
        <p class="sub">PDF or a photo, up to 10 MB each. Only the hiring team sees them.</p>
      </div>
      <ul class="list">
        <li v-for="(doc, i) in d.documents" :key="i">
          <div class="row">
            <span class="label">{{ doc.label }} <small v-if="!doc.required">optional</small></span>
            <span v-if="doc.received" class="ok"><Icon name="check" :size="14" />{{ doc.fileName ?? 'Received' }}</span>
            <label class="btn btn-sm" :class="{ quiet: doc.received }" :aria-busy="busy === i">
              <span v-if="busy === i" class="spinner" />{{ doc.received ? 'Replace' : 'Upload' }}
              <input
                type="file" class="sr-only" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                :disabled="busy !== null" :aria-label="`Upload ${doc.label}`" @change="upload(i, $event)"
              >
            </label>
          </div>
          <p v-if="errors[i]" class="form-error" role="alert"><Icon name="alert" :size="14" />{{ errors[i] }}</p>
        </li>
      </ul>
      <p class="muted small" aria-live="polite">
        <template v-if="required.length && sent === required.length">All the required documents are in. Thank you! You can still add or replace one here.</template>
        <template v-else>{{ sent }} of {{ required.length }} sent. You can come back to this link any time.</template>
      </p>
    </section>
  </main>
</template>

<style scoped>
/* Ink and paper like the booking page. */
.docs { width: min(560px, 100%); margin-inline: auto; padding: 40px 16px 64px; display: grid; gap: 20px; align-content: start; }
.docs :deep(:focus-visible) { outline-color: var(--ink); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand b { overflow-wrap: anywhere; }
.mono-mark { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--ink); color: #fff; font-size: var(--t-xs); font-weight: 600; }
.sheet { padding: 24px; display: grid; gap: 18px; box-shadow: inset 0 0 0 1px var(--line); border: 0; }
@media (max-width: 400px) { .sheet { padding: 20px 16px; } }
.sheet h1 { font-size: var(--t-2xl); letter-spacing: -0.015em; overflow-wrap: anywhere; }
.sub { margin-top: 6px; color: var(--ink-2); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.list li { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--r-panel); box-shadow: inset 0 0 0 1px var(--line); }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 32px; }
.label { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.label small { font-size: var(--t-xs); color: var(--ink-2); }
.ok { display: inline-flex; align-items: center; gap: 4px; font-size: var(--t-sm); color: var(--ok); min-width: 0; overflow-wrap: anywhere; }
.ok svg { flex: none; }
.row .btn { flex: none; cursor: pointer; }
.row .btn.quiet { background: none; box-shadow: none; color: var(--ink-2); }
/* the label is the button: show the keyboard focus that lands on the hidden input */
.row .btn:focus-within { outline: 2px solid var(--ink); outline-offset: 2px; }
.small { font-size: var(--t-sm); }
</style>
