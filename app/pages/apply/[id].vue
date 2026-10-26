<script setup lang="ts">
import { MAX_FILE_BYTES } from '~~/shared/workflow/form'
import type { FormField } from '~~/shared/workflow/types'
import { jobPostingLd } from '~~/shared/jobPosting'

definePageMeta({ layout: 'bare' })

interface PublicJob {
  id: string, title: string, description: string | null, location: string | null, employmentType: string | null, closesAt: string | null
  companyName: string | null, contactEmail: string | null, minExperienceYears: number | null, mustHaveSkills: string[]
  workplaceType: 'on_site' | 'hybrid' | 'remote' | null, openings: number, postedAt: string | null
  salary: { min: number | null, max: number | null, currency: string | null } | null
  form: FormField[], consentText: string | null, aiNoticeText: string | null
}

const route = useRoute()
const id = route.params.id as string
// Rendered on the server (routeRules), so crawlers see the post and its JSON-LD. useFetch carries the request
// context on the server and hands the result to the browser, which does not fetch again.
const { data: job, error: fetchError, refresh: load } = await useFetch<PublicJob>(`/api/public/jobs/${id}`)
const closedWhileOpen = ref(false) // the job closed between loading and sending
const loadError = computed<{ code: string, message: string } | null>(() => {
  if (closedWhileOpen.value) return { code: 'job_not_open', message: '' }
  if (!fetchError.value) return null
  const err = toApiError(fetchError.value)
  return { code: err.status === 404 ? 'job_not_open' : err.code, message: err.message }
})
// the canonical link, without ?src, so every tagged link counts as one posting
const canonical = `${useRequestURL().origin}/apply/${id}`
useHead({
  title: () => job.value ? [job.value.title, job.value.companyName].filter(Boolean).join(' at ') : 'Apply',
  link: [{ rel: 'canonical', href: canonical }],
  // "<" escaped so a description can never close the script tag
  script: () => job.value
    ? [{ type: 'application/ld+json', innerHTML: JSON.stringify(jobPostingLd(job.value, job.value.companyName, canonical)).replace(/</g, '\\u003c') }]
    : [],
})
// where the candidate came from: ?src=linkedin from the share menu, or a campaign's utm_source
const source = [route.query.src, route.query.utm_source].flat().find(v => typeof v === 'string' && v.trim())?.trim().slice(0, 60)

// Two steps on one page: read the job, then apply. The step is in the URL so Back returns to the job.
// The form stays mounted (v-show) while the job shows, so going back never loses answers.
const router = useRouter()
const hasPost = computed(() => !!(job.value?.description?.trim() || job.value?.mustHaveSkills.length || job.value?.minExperienceYears))
const step = computed(() => (!hasPost.value || route.query.step === 'apply' ? 'apply' : 'job'))
const postH = ref<HTMLElement>()
const formH = ref<HTMLElement>()
function startApply() {
  router.push({ query: { ...route.query, step: 'apply' } })
}
watch(step, async () => {
  window.scrollTo({ top: 0 })
  await nextTick()
  ;(step.value === 'job' ? postH : formH).value?.focus()
})

const CORE = [
  { key: 'first_name', label: 'First name', required: true, auto: 'given-name', type: 'text', ph: 'e.g. Wei Ming' },
  { key: 'last_name', label: 'Last name', required: true, auto: 'family-name', type: 'text', ph: 'e.g. Tan' },
  { key: 'email', label: 'Email', required: true, auto: 'email', type: 'email', ph: 'e.g. weiming.tan@gmail.com' },
  { key: 'phone', label: 'Phone', required: false, auto: 'tel', type: 'tel', ph: 'e.g. 9123 4567' },
]

// Mark whichever is the minority: "Optional" when most fields are required, else "Required".
const markOptional = computed(() => {
  const all = [...CORE, ...(job.value?.form ?? []).filter(f => f.type !== 'boolean')]
  return all.filter(f => f.required).length >= all.length / 2
})
function mark(f: { label: string, required: boolean, type?: string }) {
  if (f.type === 'boolean') return ''
  if (markOptional.value) return !f.required && !/optional/i.test(f.label) ? 'Optional' : ''
  return f.required ? 'Required' : ''
}

const meta = computed(() => {
  const j = job.value
  if (!j) return []
  return [j.location, workplaceLabel(j.workplaceType), typeLabel(j.employmentType)].filter(Boolean) as string[]
})
// The second line: what a candidate weighs before applying. "Posted yesterday" and the closing date depend on the
// reader's clock, zone and locale, which the server doesn't know: the dated parts fill in once the page runs in the
// browser, in a line already reserved, so nothing moves and hydration sees the same text.
const inBrowser = ref(false)
onMounted(() => { inBrowser.value = true })
const hasFacts = computed(() => !!job.value && (job.value.openings > 1 || !!job.value.postedAt || !!job.value.closesAt))
const facts = computed(() => {
  const j = job.value
  if (!j) return []
  return [
    j.openings > 1 ? `${j.openings} openings` : null,
    inBrowser.value && j.postedAt ? `Posted ${fmtAgo(j.postedAt).replace(/^just now$/, 'today')}` : null,
    inBrowser.value && j.closesAt ? `Applications close ${fmtDate(j.closesAt)}` : null,
  ].filter(Boolean) as string[]
})
const salary = computed(() => salaryText(job.value?.salary ?? null))
const descriptionHtml = computed(() => renderMarkdown(job.value?.description ?? ''))

function numberHint(f: FormField) {
  if (f.min !== undefined && f.max !== undefined) return `Between ${f.min} and ${f.max}`
  if (f.min !== undefined) return `${f.min} or more`
  if (f.max !== undefined) return `${f.max} or less`
  return ''
}

// list fields: one input per item
const lists = reactive<Record<string, string[]>>({})
watchEffect(() => {
  for (const f of job.value?.form ?? []) if (f.type === 'list' && !lists[f.key]) lists[f.key] = ['']
})

const errors = reactive<Record<string, string>>({})
const notices = reactive<Record<string, string>>({}) // soft hints that don't block, e.g. an odd file extension
const formError = ref('')
const consent = ref(false)
const busy = ref(false)
const sentTo = ref<string | null>(null)
const formEl = ref<HTMLFormElement>()

const clear = (key: string) => { delete errors[key] }
// the chosen file's name and size, shown in the drop area
const chosen = reactive<Record<string, string>>({})
const tooBig = (file: File) => `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Choose one under 10 MB.`

function onFile(f: FormField, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  clear(f.key)
  delete notices[f.key]
  chosen[f.key] = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ''
  if (!file) return
  if (file.size > MAX_FILE_BYTES) errors[f.key] = tooBig(file)
  // a hint only: the server checks the content
  else if (!/\.(pdf|docx)$/i.test(file.name)) notices[f.key] = 'This doesn’t look like a PDF or Word (.docx) file, so it may be refused.'
}

// "email: Invalid email" → the field before the colon, in plainer words
function issueText(key: string, msg: string) {
  if (/received undefined|required/i.test(msg)) return 'Please fill this in.'
  if (key === 'email') return 'Enter a full email address, like name@example.com.'
  return msg.charAt(0).toUpperCase() + msg.slice(1).replace(/\.?$/, '.')
}

// Turnstile: the script once per visit, one widget, the token kept until used
const { turnstileSiteKey } = useRuntimeConfig().public
const tsEl = ref<HTMLElement>()
let widgetId: string | undefined
const token = ref('')
let tsScript: Promise<void> | undefined
const turnstile = () => (window as any).turnstile
function loadTurnstile() {
  tsScript ??= new Promise((resolve, reject) => {
    if (turnstile()) return resolve()
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => resolve()
    s.onerror = reject
    document.head.appendChild(s)
  })
  return tsScript
}
watch(tsEl, async (el) => {
  if (!el) return
  try {
    await loadTurnstile()
    widgetId = turnstile().render(el, {
      sitekey: turnstileSiteKey,
      callback: (t: string) => { token.value = t },
      'expired-callback': () => { token.value = '' },
      'error-callback': () => { token.value = '' },
    })
  }
  catch {
    formError.value = 'The “are you a person” check didn’t load. Check your connection and reload the page.'
  }
})
function resetTurnstile() {
  token.value = ''
  if (widgetId !== undefined) turnstile()?.reset(widgetId)
}

async function submit() {
  const form = formEl.value!
  formError.value = ''
  for (const k of Object.keys(errors)) delete errors[k]
  for (const f of job.value!.form.filter(f => f.type === 'file')) {
    const file = (form.elements.namedItem(f.key) as HTMLInputElement).files?.[0]
    if (file && file.size > MAX_FILE_BYTES) errors[f.key] = tooBig(file)
  }
  if (Object.keys(errors).length) return focusFirst()
  if (!token.value) {
    formError.value = 'Wait for the check above to finish, then send.'
    return
  }
  const fd = new FormData(form)
  fd.delete('cf-turnstile-response') // the widget's own hidden input; the token goes in the header
  for (const f of job.value!.form) {
    if (f.type === 'boolean') fd.set(f.key, (form.elements.namedItem(f.key) as HTMLInputElement).checked ? 'true' : 'false')
  }
  if (source) fd.set('source', source)
  busy.value = true
  try {
    const res = await fetch(`/api/public/jobs/${id}/apply`, { method: 'POST', body: fd, headers: { 'cf-turnstile-response': token.value } })
    if (res.status === 201) {
      sentTo.value = String(fd.get('email'))
      window.scrollTo(0, 0)
      return
    }
    const body = await res.json().catch(() => ({}))
    // a 413 from the edge may not be our JSON
    const err = toApiError({ status: res.status, data: res.status === 413 ? { message: 'too_large' } : body })
    resetTurnstile()
    if (err.code === 'invalid_application' && err.issues.length) {
      const stray: string[] = []
      for (const i of err.issues) {
        const [path = '', ...rest] = i.message.split(':')
        const key = path.split('.')[0]!
        if (!form.querySelector(`[name="${CSS.escape(key)}"]`)) stray.push(i.message)
        else if (!errors[key]) errors[key] = issueText(key, rest.join(':').trim())
      }
      formError.value = stray.length ? stray.join(' ') : 'Some answers need another look. They’re marked above.'
      await nextTick()
      focusFirst()
    }
    else if (err.code === 'job_not_open') {
      closedWhileOpen.value = true
    }
    else formError.value = err.message
  }
  catch {
    resetTurnstile()
    formError.value = 'Your application didn’t send: we couldn’t reach the server. Check your connection and try again. Everything you entered is still here.'
  }
  finally {
    busy.value = false
  }
}

function focusFirst() {
  const first = formEl.value?.querySelector<HTMLElement>('[aria-invalid="true"]')
  first?.focus()
  first?.scrollIntoView({ block: 'center' })
}
</script>

<template>
  <main class="apply">
    <div v-if="loadError?.code === 'job_not_open'" class="ending">
      <h1>This job isn’t taking applications any more.</h1>
      <p class="muted">It may have been filled, or the closing date has passed.</p>
      <NuxtLink to="/careers" class="btn">See the jobs that are open</NuxtLink>
    </div>

    <div v-else-if="loadError" class="ending" role="alert">
      <h1>This page didn’t load.</h1>
      <p class="muted">{{ loadError.message }}</p>
      <button class="btn" @click="load()">Try again</button>
    </div>

    <div v-else-if="sentTo" class="ending" aria-live="polite">
      <p class="eyebrow">{{ [job?.companyName, job?.title].filter(Boolean).join(' · ') }}</p>
      <h1>Application sent</h1>
      <p>We’ve emailed <b class="addr">{{ sentTo }}</b> a link where you can follow your application, and we’ll write there about next steps. Reply to any of our emails to reach {{ job?.companyName ? `the ${job.companyName} team` : 'the team' }}<template v-if="job?.contactEmail">, or write to <a :href="`mailto:${job.contactEmail}`">{{ job.contactEmail }}</a></template>.</p>
      <p class="muted">You can close this page.</p>
    </div>

    <template v-else-if="job">
      <section v-show="step === 'job'" class="post" aria-labelledby="post-h">
        <header class="head">
          <p v-if="job.companyName" class="company">{{ job.companyName }}</p>
          <h1 id="post-h" ref="postH" tabindex="-1">{{ job.title }}</h1>
          <p v-if="meta.length" class="meta">
            <span v-for="m in meta" :key="m">{{ m }}</span>
          </p>
          <p v-if="salary" class="salary">{{ salary }}</p>
          <p v-if="hasFacts" class="meta facts">
            <span v-for="f in facts" :key="f">{{ f }}</span>
          </p>
        </header>
        <!-- renderMarkdown escapes all HTML before adding its few tags -->
        <div v-if="job.description" class="prose desc" v-html="descriptionHtml" />
        <section v-if="job.mustHaveSkills.length || job.minExperienceYears" class="looking" aria-labelledby="look-h">
          <h2 id="look-h">What we look for</h2>
          <p v-if="job.minExperienceYears">{{ job.minExperienceYears }}+ {{ job.minExperienceYears === 1 ? 'year' : 'years' }} of relevant experience</p>
          <ul v-if="job.mustHaveSkills.length" class="skills">
            <li v-for="sk in job.mustHaveSkills" :key="sk">{{ sk }}</li>
          </ul>
        </section>
        <div class="go">
          <button type="button" class="btn btn-primary btn-lg send" @click="startApply">Apply for this job<Icon name="arrow-right" /></button>
        </div>
      </section>

      <form v-show="step === 'apply'" ref="formEl" class="form" @submit.prevent="submit">
        <header class="form-head">
          <button v-if="hasPost" type="button" class="crumb back" @click="router.back()"><Icon name="arrow-left" :size="16" />Job details</button>
          <p class="company">{{ [job.companyName, meta[0]].filter(Boolean).join(' · ') }}</p>
          <h1 ref="formH" tabindex="-1">Apply for {{ job.title }}</h1>
        </header>
        <div class="names">
          <div v-for="c in CORE" :key="c.key" class="field" :class="{ wide: c.key === 'email' || c.key === 'phone' }">
            <label :for="`f-${c.key}`">{{ c.label }} <span v-if="mark(c)" class="mark">{{ mark(c) }}</span></label>
            <input
              :id="`f-${c.key}`" :name="c.key" :type="c.type" :autocomplete="c.auto" :required="c.required"
              :inputmode="c.type === 'tel' ? 'tel' : undefined" maxlength="100" :placeholder="c.ph"
              :aria-invalid="errors[c.key] ? 'true' : undefined" :aria-describedby="errors[c.key] ? `e-${c.key}` : undefined"
              @input="clear(c.key)"
            >
            <p v-if="errors[c.key]" :id="`e-${c.key}`" class="error">{{ errors[c.key] }}</p>
          </div>
        </div>

        <template v-for="f in job.form" :key="f.key">
          <div v-if="f.type === 'boolean'" class="field">
            <label class="check">
              <input :id="`f-${f.key}`" :name="f.key" type="checkbox" :aria-invalid="errors[f.key] ? 'true' : undefined" @change="clear(f.key)">
              <span>{{ f.label }}</span>
            </label>
            <p v-if="errors[f.key]" class="error">{{ errors[f.key] }}</p>
          </div>

          <fieldset v-else-if="f.type === 'enum' && (f.options?.length ?? 0) <= 5" class="field" :aria-describedby="errors[f.key] ? `e-${f.key}` : undefined">
            <legend class="legend">{{ f.label }} <span v-if="mark(f)" class="mark">{{ mark(f) }}</span></legend>
            <div class="radios">
              <label v-for="(o, i) in f.options" :key="o" class="check">
                <input
                  :id="i === 0 ? `f-${f.key}` : undefined" type="radio" :name="f.key" :value="o" :required="f.required"
                  :aria-invalid="errors[f.key] ? 'true' : undefined" @change="clear(f.key)"
                ><span>{{ o }}</span>
              </label>
            </div>
            <p v-if="errors[f.key]" :id="`e-${f.key}`" class="error">{{ errors[f.key] }}</p>
          </fieldset>

          <fieldset v-else-if="f.type === 'list'" class="field">
            <legend class="legend">{{ f.label }} <span v-if="mark(f)" class="mark">{{ mark(f) }}</span></legend>
            <ListInput v-model="lists[f.key]!" :id="`f-${f.key}`" :name="f.key" :label="f.label" :max="f.max" :required="f.required" :invalid="!!errors[f.key]" @input="clear(f.key)" />
            <p v-if="errors[f.key]" class="error">{{ errors[f.key] }}</p>
          </fieldset>

          <div v-else class="field">
            <label :for="`f-${f.key}`">{{ f.label }} <span v-if="mark(f)" class="mark">{{ mark(f) }}</span></label>
            <textarea
              v-if="f.type === 'text'" :id="`f-${f.key}`" :name="f.key" :required="f.required" :maxlength="f.max ?? 10000" rows="4"
              :aria-invalid="errors[f.key] ? 'true' : undefined" :aria-describedby="errors[f.key] ? `e-${f.key}` : undefined" @input="clear(f.key)"
            />
            <select
              v-else-if="f.type === 'enum'" :id="`f-${f.key}`" :name="f.key" :required="f.required"
              :aria-invalid="errors[f.key] ? 'true' : undefined" :aria-describedby="errors[f.key] ? `e-${f.key}` : undefined" @change="clear(f.key)"
            >
              <option value="">Choose…</option>
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <div v-else-if="f.type === 'file'" class="drop" :class="{ has: chosen[f.key] }">
              <Icon :name="chosen[f.key] ? 'file' : 'upload'" :size="20" />
              <span class="drop-text"><b>{{ chosen[f.key] || 'Choose a file' }}</b><span>{{ chosen[f.key] ? 'Choose another to replace it' : 'or drop it here' }}</span></span>
              <input
                :id="`f-${f.key}`" :name="f.key" type="file" accept=".pdf,.docx" :required="f.required"
                :aria-invalid="errors[f.key] ? 'true' : undefined" :aria-describedby="`h-${f.key}${errors[f.key] ? ` e-${f.key}` : ''}`" @change="onFile(f, $event)"
              >
            </div>
            <input
              v-else :id="`f-${f.key}`" :name="f.key" :required="f.required"
              :type="f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'"
              :inputmode="f.type === 'number' ? 'decimal' : undefined" :step="f.type === 'number' ? 'any' : undefined"
              :min="f.type === 'number' ? f.min : undefined" :max="f.type === 'number' ? f.max : undefined"
              :minlength="f.type === 'string' ? f.min : undefined" :maxlength="f.type === 'string' ? (f.max ?? 500) : undefined"
              :aria-invalid="errors[f.key] ? 'true' : undefined" :aria-describedby="f.type === 'number' ? `h-${f.key}` : errors[f.key] ? `e-${f.key}` : undefined"
              @input="clear(f.key)"
            >
            <p v-if="f.type === 'file'" :id="`h-${f.key}`" class="hint">PDF or Word, up to 10 MB</p>
            <p v-if="f.type === 'number' && numberHint(f)" :id="`h-${f.key}`" class="hint">{{ numberHint(f) }}</p>
            <p v-if="notices[f.key] && !errors[f.key]" class="hint warn">{{ notices[f.key] }}</p>
            <p v-if="errors[f.key]" :id="`e-${f.key}`" class="error">{{ errors[f.key] }}</p>
          </div>
        </template>

        <ApplyNotices v-model="consent" :consent-text="job.consentText" :ai-notice-text="job.aiNoticeText" />

        <div ref="tsEl" class="turnstile" />

        <p v-if="formError" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ formError }}</p>
        <button class="btn btn-primary btn-lg send" :aria-busy="busy" :disabled="busy">
          <span v-if="busy" class="spinner" />
          <span>{{ busy ? 'Sending…' : 'Send application' }}</span>
        </button>
      </form>
    </template>

    <div v-else class="loading" aria-busy="true">
      <div class="skeleton" style="height: 34px; width: 70%" />
      <div class="skeleton" style="height: 16px; width: 45%" />
      <div class="skeleton" style="height: 120px; margin-top: 16px" />
    </div>
  </main>
</template>

<style scoped>
/* Candidates see ink and paper; the submit button is the one accent. */
.apply {
  --accent-tint: oklch(0.93 0.01 330);
  width: min(640px, 100%); margin-inline: auto; padding: 40px 16px 64px; display: grid; gap: 24px; align-content: start;
}
.apply :deep(:where(input[type="checkbox"], input[type="radio"]):checked) { background: var(--ink); border-color: var(--ink); }
.apply :deep(:where(input, select, textarea):focus-visible) { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px oklch(0.24 0.018 330 / 0.14); caret-color: var(--ink); }
.apply :deep(:focus-visible) { outline-color: var(--ink); }
.head { display: grid; gap: 10px; }
.head h1 { font-size: clamp(var(--t-2xl), 6vw, var(--t-3xl)); letter-spacing: -0.025em; }
/* each fact keeps its own separator, so a wrap never leaves a dot at a line end */
.meta { display: flex; flex-wrap: wrap; column-gap: 12px; overflow: hidden; color: var(--ink-2); }
.meta span { white-space: nowrap; }
/* every fact carries a dot to its left; the one that starts a line falls outside the box and is clipped */
.meta span::before { content: "·"; display: inline-block; width: 4px; margin-left: -8px; margin-right: 4px; text-align: center; color: var(--ink-3); }
.desc { font-size: var(--t-lg); }
.salary { margin-top: 10px; font-size: var(--t-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
/* min-height: the dated facts arrive after hydration into this line */
.facts { margin-top: 4px; font-size: var(--t-sm); min-height: 1lh; }
.post { display: grid; gap: 24px; }
.company { font-weight: 600; color: var(--ink-2); margin-bottom: 6px; }
h1:focus { outline: none; }
.looking { display: grid; gap: 10px; padding: 20px; border-radius: var(--r-panel); background: var(--surface); border: 1px solid var(--line); }
.looking h2 { font-size: var(--t-lg); }
.skills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.skills li { padding: 4px 12px; border-radius: var(--r-pill); background: var(--sunk); font-size: var(--t-sm); font-weight: 500; }
/* on phones the apply button stays under the thumb while reading; static again on short screens */
.go { position: sticky; bottom: 0; padding: 12px 0 16px; background: linear-gradient(to bottom, transparent, var(--bg) 30%); }
@media (max-height: 500px) { .go { position: static; } }
.form { display: grid; gap: 22px; }
.form-head { display: grid; gap: 2px; }
.back { border: 0; background: none; padding: 0; cursor: pointer; justify-self: start; margin-bottom: 14px; }
.form .field > label, .form .legend { font-size: var(--t-md); }
.form input:not([type="checkbox"], [type="radio"], [type="file"]), .form select { min-height: 44px; font-size: var(--t-lg); }
.form textarea { font-size: var(--t-lg); }
/* the native file input covers the area (keyboard, drop and form data stay native); the area shows the choice */
.drop {
  position: relative; display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 16px;
  border: 1.5px dashed var(--line-2); border-radius: var(--r-field); background: var(--surface); color: var(--ink-2);
}
.drop.has { border-style: solid; border-color: var(--ink-3); color: var(--ink); }
.drop:hover { border-color: var(--ink-3); }
.drop:focus-within { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px oklch(0.24 0.018 330 / 0.14); }
.drop-text { display: grid; min-width: 0; }
.drop-text b { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.drop-text span { font-size: var(--t-sm); }
.drop input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.drop:has(input[aria-invalid="true"]) { border-color: var(--bad); }
.names { display: grid; grid-template-columns: 1fr 1fr; gap: 22px 16px; }
.names .wide { grid-column: 1 / -1; }
@media (max-width: 420px) { .names { grid-template-columns: 1fr; } }
.mark { font-weight: 400; color: var(--ink-2); margin-left: 4px; font-size: var(--t-sm); }
.legend { margin-bottom: 8px; padding: 0; }
.radios { display: grid; gap: 10px; }
.radios .check { min-height: 28px; align-items: center; }
.radios .check input { margin-top: 0; }
.hint.warn { color: var(--warn); }
.turnstile { min-height: 65px; }
.send { width: 100%; }
@media (min-width: 640px) { .send { width: auto; justify-self: start; padding-inline: 32px; } }
.ending { display: grid; gap: 14px; padding-top: 12vh; max-width: 52ch; }
.ending h1 { font-size: clamp(var(--t-2xl), 6vw, var(--t-3xl)); letter-spacing: -0.025em; }
.ending p:not(.eyebrow) { font-size: var(--t-lg); }
.ending .btn { justify-self: start; }
.addr { overflow-wrap: anywhere; }
.loading { display: grid; gap: 12px; }
</style>
