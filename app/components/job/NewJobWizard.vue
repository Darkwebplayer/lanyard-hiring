<script setup lang="ts">
import { TEMPLATES } from '~~/shared/workflow/templates'
import type { Requirements } from '~~/shared/workflow/job'
import type { Graph } from '~~/shared/workflow/types'

// New job in five steps. Steps 3 and 4 go in the same create call as the title; the side panel says where each lives later.
const props = defineProps<{ jobs: { id: string, title: string }[] }>()
const { canAsk } = useMe()
const { flowPresets } = useFlowPresets()

type From = 'template' | 'blank' | 'job' | 'preset' | 'describe'
const empty = () => ({
  title: '', openings: 1 as number | '', from: 'template' as From, templateId: 'simple', jobId: '', presetId: '', describe: '',
  description: '', workplace: '' as '' | 'on_site' | 'hybrid' | 'remote', location: '', closesAt: '',
  salaryMin: '' as number | '', salaryMax: '' as number | '', currency: 'SGD', showSalary: false,
  skills: [] as string[], minYears: '' as number | '',
})
const form = reactive(empty())

const STEPS = ['The role', 'How you hire', 'About the job', 'Must-haves', 'Check']
const step = ref(1)
const dlg = ref<HTMLDialogElement>()
const heading = ref<HTMLElement>()
const titleInput = ref<HTMLInputElement>()
const creating = ref(false)
const createError = ref<string | null>(null)
const presetGone = ref(false)
const otherOpen = ref(false)

// ---- how you hire ----
const hasAi = (w: Graph) => w.nodes.some(n => n.type === 'ai_review')
const stagesOf = (w: Graph) => (w.stages ?? []).map(s => ({ name: s.name, ai: s.nodeKeys.some(k => w.nodes.find(n => n.key === k)?.type === 'ai_review') }))
const TEMPLATE_CARDS = TEMPLATES.map(t => ({ ...t, stages: stagesOf(t.workflow) }))
// what the runners in the diagram stand for, and what the score does, in each template's own terms
const STORY: Record<string, string> = {
  simple: 'You read each application, interview the ones you like, then decide.',
  ai_screening: 'One person scores 78 and goes to interview. Another scores 31 and gets a polite no.',
  high_volume: 'A short form, an AI screen, one phone call, then yes or no.',
  panel: 'A phone screen, then a panel that scores without seeing each other.',
}
const AI_LINE: Record<string, string> = {
  ai_screening: 'Scores of 70 and up go to the interview. Under 40 are closed. The rest come to you.',
  high_volume: 'Scores under 35 are closed. Everyone else goes on to the call.',
  panel: 'Scores of 70 and up go to the phone screen. Under 40 are closed. The rest come to you.',
}
const counts = (p: { form: unknown[], workflow: { nodes: { type: string }[] } }) =>
  `${plural(p.workflow.nodes.filter(n => n.type !== 'application_received').length, 'step')} · ${plural(p.form.length, 'field')}`
// one radio group: template:<id>, blank, job, describe, then each saved flow as preset:<id>
const choice = computed({
  get: () => (form.from === 'preset' ? `preset:${form.presetId}` : form.from === 'template' ? `template:${form.templateId}` : form.from),
  set: (v: string) => v.startsWith('preset:') ? Object.assign(form, { from: 'preset', presetId: v.slice(7) })
    : v.startsWith('template:') ? Object.assign(form, { from: 'template', templateId: v.slice(9) })
    : (form.from = v as From),
})
const chosen = computed(() => {
  const t = form.from === 'template' ? TEMPLATE_CARDS.find(t => t.id === form.templateId) : undefined
  if (t) return { name: t.name, stages: t.stages, story: STORY[t.id] ?? t.description, ai: hasAi(t.workflow), aiLine: AI_LINE[t.id] }
  const p = form.from === 'preset' ? flowPresets.value?.find(p => p.id === form.presetId) : undefined
  if (p) return { name: p.name, stages: stagesOf(p.workflow), story: p.description || 'Your saved flow, as you set it up.', ai: hasAi(p.workflow), aiLine: undefined }
  if (form.from === 'describe') {
    return {
      name: 'Described in your words (AI drafts it next)', stages: ['Your step 1', 'Your step 2', 'Decision'].map(name => ({ name, ai: false })),
      story: 'After you create the job, AI lays out the stages from what you wrote. Nothing is saved until you say so.', ai: false, aiLine: undefined,
    }
  }
  if (form.from === 'job') {
    const j = props.jobs.find(j => j.id === form.jobId)
    return { name: `A copy of ${j?.title ?? 'another job'}`, stages: [], story: 'Its form and stages come across. Its candidates don’t.', ai: false, aiLine: undefined }
  }
  return { name: 'Start blank', stages: [], story: 'Only Applied to start. You add every step on the Stages tab.', ai: false, aiLine: undefined }
})

// ---- about the job and must-haves (same shapes and checks as the Details tab) ----
const WORKPLACES = [{ value: 'on_site', label: 'On-site' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'remote', label: 'Remote' }] as const
const salaryError = computed(() => form.salaryMin !== '' && form.salaryMax !== '' && form.salaryMin > form.salaryMax ? 'The minimum is higher than the maximum.' : null)
const currency = computed(() => form.currency.trim().toUpperCase() || 'SGD')
const salary = computed(() => salaryText({
  min: form.salaryMin === '' ? null : form.salaryMin, max: form.salaryMax === '' ? null : form.salaryMax,
  currency: /^[A-Z]{3}$/.test(currency.value) ? currency.value : null, // Intl throws on a half-typed code
}))
function requirements(): Requirements {
  const r: Requirements = {}
  if (form.minYears !== '') r.min_experience_years = form.minYears
  if (form.skills.length) r.must_have_skills = form.skills
  if (form.salaryMin !== '') r.salary_min = form.salaryMin
  if (form.salaryMax !== '') r.salary_max = form.salaryMax
  if (form.location.trim()) r.location = form.location.trim()
  if (form.workplace) r.workplace_type = form.workplace
  if (form.salaryMin !== '' || form.salaryMax !== '') r.salary_currency = currency.value
  if (form.showSalary && r.salary_currency) r.show_salary = true
  return r
}
const about = computed(() => [
  workplaceLabel(form.workplace || null), form.location.trim(),
  salary.value && `${salary.value}${form.showSalary ? '' : ' (team only)'}`,
  form.closesAt && `closes ${fmtDate(`${form.closesAt}T00:00:00`)}`,
].filter(Boolean).join(' · '))
const mustHave = computed(() => [form.skills.join(', '), form.minYears !== '' && `${plural(form.minYears, 'year')} or more`].filter(Boolean).join(' · '))

// ---- steps ----
const TITLES = ['What’s the job called?', 'How do you want to hire?', 'About the job', 'What must they have?', 'Check and create']
const hint = computed(() => [
  'Use the title people search for. It’s the heading on your apply page.',
  'Pick the closest one. Every step can be changed later.',
  'Candidates read this on the apply page. You can skip it and write it later.',
  chosen.value.ai ? 'The AI review scores each CV against these two things, and only these.' : 'What someone needs to do this job. Candidates see the skills on the apply page.',
  'This makes a draft. Nobody can apply until you publish it.',
][step.value - 1])
function go(n: number) {
  step.value = n
  nextTick(() => heading.value?.focus())
}
function submit() {
  if (step.value === 3 && salaryError.value) return
  if (step.value < 5) go(step.value + 1)
  else create()
}
// skipping means "not now", so nothing half-typed (or invalid) here goes in
function skip() {
  Object.assign(form, { description: '', workplace: '', location: '', closesAt: '', salaryMin: '', salaryMax: '', currency: 'SGD', showSalary: false })
  go(4)
}

// ?new=standard (the library's Standard hire) is the AI screening template; ?new=<id> a saved flow; nothing = Simple.
// ?new=first (from the setup wizard) opens like the button: step 1, Simple.
// From a link, the way to start is already picked, so it opens on that step.
function open(start?: string) {
  if (start === 'first') start = undefined
  const preset = start && start !== 'standard' ? flowPresets.value?.find(p => p.id === start) : undefined
  presetGone.value = !!start && start !== 'standard' && !preset
  Object.assign(form, empty(), {
    from: preset ? 'preset' : 'template', templateId: start === 'standard' ? 'ai_screening' : 'simple',
    presetId: preset?.id ?? '', jobId: props.jobs[0]?.id ?? '',
  })
  otherOpen.value = !!preset
  createError.value = null
  step.value = start ? 2 : 1
  dlg.value?.showModal()
  nextTick(() => (step.value === 1 ? titleInput.value : heading.value)?.focus())
}
defineExpose({ open })

async function create() {
  if (!form.title.trim()) return go(1) // opened from a link, the title step may never have been seen
  creating.value = true
  createError.value = null
  try {
    const from = form.from === 'job' ? { kind: 'job', jobId: form.jobId }
      : form.from === 'preset' ? { kind: 'preset', presetId: form.presetId }
      : form.from === 'template' ? { kind: 'template', id: form.templateId }
      : { kind: 'blank' } // blank, and describe: the flow tab drafts the steps from the words
    const { job } = await api<{ job: { id: string } }>('/api/jobs', {
      method: 'POST',
      body: {
        title: form.title, openings: form.openings, from, description: form.description, requirements: requirements(),
        closesAt: form.closesAt ? new Date(`${form.closesAt}T23:59:59`).toISOString() : null,
      },
    })
    if (form.from === 'describe') useState<string>('describe-seed').value = form.describe.trim()
    dlg.value?.close()
    // straight to its stages: the flow is what they just chose; a saved flow may leave things to fix
    await navigateTo(form.from === 'preset' ? `/jobs/${job.id}/flow?check=1` : `/jobs/${job.id}/flow`)
  }
  catch (e) { createError.value = toApiError(e).message }
  finally { creating.value = false }
}

const TABS = ['Pipeline', 'Stages', 'Form', 'Details']
const laterTab = computed(() => (step.value === 2 ? 'Stages' : 'Details'))
const TAB_CAPS = ['Everyone who applied, by stage.', 'What happens to each applicant.', 'What you ask when they apply.', 'What candidates read about the job.']
</script>

<template>
  <!-- no close on a backdrop click: five steps of typing are too much to lose to a stray click -->
  <dialog ref="dlg" class="dialog wizard" aria-labelledby="nj-h">
    <form @submit.prevent="submit">
      <header class="head">
        <div class="head-row">
          <h2 id="nj-h">New job</h2>
          <button type="button" class="btn btn-icon btn-quiet" aria-label="Close" @click="dlg?.close()"><Icon name="x" /></button>
        </div>
        <ol class="steps" aria-label="Progress">
          <li v-for="(s, i) in STEPS" :key="s" :class="{ done: i + 1 < step, on: i + 1 === step }" :aria-current="i + 1 === step ? 'step' : undefined">
            <i><Icon v-if="i + 1 < step" name="check" :size="12" /><template v-else>{{ i + 1 }}</template></i>{{ s }}
            <span v-if="i === 3 && chosen.ai" class="chip chip-ink ai-tag">AI</span>
          </li>
        </ol>
      </header>

      <div class="body">
        <section class="main">
          <div class="intro">
            <h3 ref="heading" tabindex="-1">{{ TITLES[step - 1] }}</h3>
            <p class="hint">{{ hint }}</p>
          </div>

          <template v-if="step === 1">
            <div class="field">
              <label for="nj-title">Job title</label>
              <input id="nj-title" ref="titleInput" v-model="form.title" required pattern=".*\S.*" maxlength="200" autocomplete="off" placeholder="e.g. Shop assistant">
            </div>
            <div class="field narrow">
              <label for="nj-openings">How many people?</label>
              <input id="nj-openings" v-model.number="form.openings" type="number" min="1" max="10000" required>
            </div>
            <p class="hint">Hiring two of the same role? Make one job with 2 openings, not two jobs.</p>
          </template>

          <template v-else-if="step === 2">
            <p v-if="presetGone" class="gone" role="status"><Icon name="alert" :size="14" />That saved flow was deleted, so pick another way to start.</p>
            <div class="tpls">
              <label v-for="t in TEMPLATE_CARDS" :key="t.id" class="tpl">
                <input v-model="choice" type="radio" name="nj-from" :value="`template:${t.id}`">
                <b class="tpl-name">{{ t.name }}</b>
                <span class="tpl-desc">{{ t.description }}</span>
                <span class="tpl-stages" :aria-label="`Stages: ${t.stages.map(s => s.name).join(', ')}`">
                  <span v-for="s in t.stages" :key="s.name" class="chip" :class="{ 'chip-ink': s.ai }"><Icon v-if="s.ai" name="ai" />{{ s.name }}</span>
                </span>
              </label>
            </div>
            <template v-if="canAsk">
              <label class="tpl describe">
                <input v-model="choice" type="radio" name="nj-from" value="describe">
                <span class="chip chip-ink">AI</span>
                <span class="describe-text">
                  <b class="tpl-name">Describe it in your own words</b>
                  <span class="tpl-desc">“We call people, then the owner meets the good ones.” AI drafts the stages for you to check.</span>
                </span>
              </label>
              <div v-if="form.from === 'describe'" class="field">
                <label for="nj-describe">How you hire</label>
                <textarea id="nj-describe" v-model="form.describe" required maxlength="2000" rows="4" placeholder="Café barista: quick call, one paid trial shift, then offer." />
              </div>
            </template>
            <label class="tpl">
              <input v-model="choice" type="radio" name="nj-from" value="blank">
              <b class="tpl-name">Start blank</b>
              <span class="tpl-desc">Only “Applied”. You add every step yourself.</span>
            </label>
            <details class="other" :open="otherOpen" @toggle="otherOpen = ($event.target as HTMLDetailsElement).open">
              <summary>Or reuse: a saved flow, or copy another job</summary>
              <div class="other-body">
                <div v-if="flowPresets?.length" class="presets" role="group" aria-labelledby="nj-presets">
                  <span id="nj-presets" class="eyebrow">Your saved flows</span>
                  <label v-for="p in flowPresets" :key="p.id" class="check"><input v-model="choice" type="radio" name="nj-from" :value="`preset:${p.id}`"><span><b>{{ p.name }} <span class="n">{{ counts(p) }}</span></b><span v-if="p.description" class="hint">{{ p.description }}</span></span></label>
                </div>
                <label class="check"><input v-model="choice" type="radio" name="nj-from" value="job" :disabled="!jobs.length"><span><b>Copy another job</b><span class="hint">Its form and flow, not its candidates.</span></span></label>
                <select v-if="form.from === 'job'" v-model="form.jobId" aria-label="Job to copy" required class="copy-from">
                  <option v-for="j in jobs" :key="j.id" :value="j.id">{{ j.title }}</option>
                </select>
              </div>
            </details>
          </template>

          <template v-else-if="step === 3">
            <div class="field">
              <label for="nj-desc">Description</label>
              <JobMarkdownEditor id="nj-desc" v-model="form.description" :maxlength="20000" />
            </div>
            <div class="grid2">
              <div class="field">
                <span id="nj-work" class="label">Where</span>
                <div class="seg" role="radiogroup" aria-labelledby="nj-work">
                  <label v-for="w in WORKPLACES" :key="w.value"><input v-model="form.workplace" type="radio" name="nj-workplace" :value="w.value"><span>{{ w.label }}</span></label>
                </div>
              </div>
              <div class="field">
                <label for="nj-loc">Location</label>
                <input id="nj-loc" v-model="form.location" maxlength="200" placeholder="e.g. Jurong East or Tampines">
              </div>
              <div class="field">
                <span class="label">Salary range</span>
                <div class="salary">
                  <input v-model.number="form.salaryMin" type="number" min="0" aria-label="Salary minimum" placeholder="Min" :aria-invalid="!!salaryError">
                  <span class="hint">to</span>
                  <input v-model.number="form.salaryMax" type="number" min="0" aria-label="Salary maximum" placeholder="Max" :aria-invalid="!!salaryError">
                  <input v-model="form.currency" class="cur" maxlength="3" aria-label="Currency, three letters" placeholder="SGD" autocapitalize="characters" spellcheck="false">
                </div>
                <span v-if="salaryError" class="error"><Icon name="alert" :size="14" />{{ salaryError }}</span>
                <label class="check"><input v-model="form.showSalary" type="checkbox" :disabled="form.salaryMin === '' && form.salaryMax === ''">Show the salary on the apply page</label>
              </div>
              <div class="field">
                <label for="nj-close">Closes on</label>
                <input id="nj-close" v-model="form.closesAt" type="date">
                <span class="hint">Leave empty to keep it open.</span>
              </div>
            </div>
          </template>

          <template v-else-if="step === 4">
            <div class="field">
              <label for="nj-skill">Must-have skills</label>
              <JobSkillsInput id="nj-skill" v-model="form.skills" placeholder="Add a skill and press Enter" />
              <span class="hint">Press Enter or comma after each. Paste a comma list to add several.</span>
            </div>
            <div class="field narrow">
              <label for="nj-years">At least this many years</label>
              <input id="nj-years" v-model.number="form.minYears" type="number" min="0" max="60" step="0.5">
            </div>
            <p v-if="chosen.ai" class="tip"><b>Tip</b><span>The AI reads the description, but scores against these. A hard rule like “no more than 6 demerit points” is safer here as a skill, or as a question on the form.</span></p>
          </template>

          <template v-else>
            <dl class="summary">
              <div class="sumrow">
                <dt>Job</dt>
                <dd><span><b>{{ form.title || 'No title yet' }}</b> · {{ plural(Number(form.openings) || 1, 'opening') }}</span></dd>
                <button type="button" class="link" aria-label="Edit the job title" @click="go(1)">Edit</button>
              </div>
              <div class="sumrow">
                <dt>How you hire</dt>
                <dd>
                  {{ chosen.name }}
                  <span v-if="form.from === 'describe'" class="chips"><span class="chip chip-ink">Drafted after you create</span></span>
                  <span v-else-if="chosen.stages.length" class="chips"><span v-for="s in chosen.stages" :key="s.name" class="chip" :class="{ 'chip-ink': s.ai }"><Icon v-if="s.ai" name="ai" />{{ s.name }}</span></span>
                </dd>
                <button type="button" class="link" aria-label="Edit how you hire" @click="go(2)">Edit</button>
              </div>
              <div class="sumrow">
                <dt>About</dt>
                <dd>
                  <span v-if="about">{{ about }}</span>
                  <span v-if="form.description.trim()" class="clip faint">{{ form.description }}</span>
                  <span v-if="!about && !form.description.trim()" class="faint">Not written yet. Fine for now.</span>
                </dd>
                <button type="button" class="link" aria-label="Edit about the job" @click="go(3)">Edit</button>
              </div>
              <div class="sumrow">
                <dt>Must have</dt>
                <dd><span v-if="mustHave">{{ mustHave }}</span><span v-else class="faint">Nothing yet</span></dd>
                <button type="button" class="link" aria-label="Edit the must-haves" @click="go(4)">Edit</button>
              </div>
            </dl>
            <p v-if="createError" class="form-error" role="alert"><Icon name="alert" />{{ createError }}</p>
          </template>
        </section>

        <aside class="aside">
          <template v-if="step === 1">
            <p class="eyebrow">What you’re making</p>
            <h4>A job has four tabs</h4>
            <div class="tabmap cycle" aria-hidden="true"><span v-for="t in TABS" :key="t">{{ t }}</span></div>
            <div class="cap"><span v-for="(c, i) in TAB_CAPS" :key="i"><b>{{ TABS[i] }}: </b>{{ c }}</span></div>
            <p class="hint">These steps fill them in for you. After this, you change things in the tabs.</p>
          </template>
          <template v-else-if="step === 2">
            <p class="eyebrow">What happens to an applicant</p>
            <HelpFlowDiagram v-if="chosen.stages.length" :stages="chosen.stages" />
            <p class="hint">{{ chosen.story }}</p>
          </template>
          <template v-else-if="step === 3">
            <p class="eyebrow">Candidates see</p>
            <div class="preview" aria-hidden="true">
              <b>{{ form.title || 'Your job title' }}</b>
              <span v-if="workplaceLabel(form.workplace || null) || form.location.trim() || (form.showSalary && salary)" class="chips">
                <span v-if="workplaceLabel(form.workplace || null) || form.location.trim()" class="chip">{{ [workplaceLabel(form.workplace || null), form.location.trim()].filter(Boolean).join(' · ') }}</span>
                <span v-if="form.showSalary && salary" class="chip">{{ salary }}</span>
              </span>
              <span class="bar" /><span class="bar short" />
              <span class="btn btn-primary btn-sm">Apply</span>
            </div>
          </template>
          <template v-else-if="step === 4">
            <template v-if="chosen.ai">
              <p class="eyebrow">What the AI reads</p>
              <HelpAiReadsDiagram />
              <p class="hint">{{ chosen.aiLine ?? 'What each score does is set in the AI review step, on the Stages tab.' }}</p>
            </template>
            <template v-else>
              <p class="eyebrow">Who reads these</p>
              <p class="hint">No step in this flow uses AI, so these are for you and for candidates: a plain list of what the job needs. If you add an AI review later, it scores each CV against them.</p>
            </template>
          </template>
          <template v-else>
            <p class="eyebrow">After you create it</p>
            <div class="next">
              <i>1</i>
              <span v-if="form.from === 'describe'"><b>Draft your stages.</b><span class="hint">You land on Stages with your words ready. AI drafts the steps for you to check.</span></span>
              <span v-else><b>Read your stages.</b><span class="hint">You land on Stages. Each one says in words what happens.</span></span>
            </div>
            <div class="next"><i>2</i><span><b>Check the form.</b><span class="hint">Add a question if you need one.</span></span></div>
            <div class="next"><i>3</i><span><b>Publish.</b><span class="hint">You get the apply link to share.</span></span></div>
          </template>

          <div v-if="step >= 2 && step <= 4" class="later">
            <p class="eyebrow">Later, change it in<span class="sr-only"> the {{ laterTab }} tab</span></p>
            <div class="tabmap" aria-hidden="true"><span v-for="t in TABS" :key="t" :class="{ lit: t === laterTab }">{{ t }}</span></div>
          </div>
        </aside>
      </div>

      <footer class="foot">
        <button v-if="step > 1" type="button" class="btn" @click="go(step - 1)">Back</button>
        <span v-else class="hint">Takes about two minutes.</span>
        <div class="foot-right">
          <button v-if="step === 3" type="button" class="btn btn-quiet" @click="skip">Skip for now</button>
          <button v-if="step < 5" class="btn btn-primary" :disabled="step === 3 && !!salaryError">Next</button>
          <button v-else class="btn btn-primary" :aria-busy="creating" :disabled="creating"><span v-if="creating" class="spinner" />Create job</button>
        </div>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
dialog.wizard { width: min(960px, calc(100vw - 32px)); }
.wizard form { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: min(760px, calc(100dvh - 48px)); }
.head { display: grid; gap: 14px; padding: 22px 28px 18px; border-bottom: 1px solid var(--line); }
.head-row { display: flex; justify-content: space-between; align-items: center; }
.head h2 { font-size: var(--t-xl); letter-spacing: -0.01em; }
.ai-tag { height: 18px; padding: 0 6px; font-size: 10px; }
.body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 0; }
.main { display: grid; gap: 20px; align-content: start; padding: 28px; overflow-y: auto; }
.intro { display: grid; gap: 6px; }
.intro h3 { font-size: var(--t-xl); font-weight: 600; outline: none; }
.hint { font-size: var(--t-sm); color: var(--ink-2); }
.narrow { max-width: 220px; }
.grid2 .seg { justify-self: start; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.salary { display: flex; gap: 6px; align-items: center; }
.salary input { min-width: 0; flex: 1; }
.salary .cur { flex: 0 0 64px; text-transform: uppercase; font-family: var(--mono); }

.tpls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.tpl {
  position: relative; display: grid; gap: 4px; align-content: start; padding: 14px 16px; border-radius: var(--r-panel);
  border: 1px solid var(--line); background: var(--surface); cursor: pointer; transition: border-color var(--t-micro) var(--ease), box-shadow var(--t-micro) var(--ease);
}
.tpl:hover { border-color: var(--line-2); }
.tpl input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.tpl:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.tpl:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.tpl-name { font-size: var(--t-lg); font-weight: 600; }
.tpl-desc { font-size: var(--t-sm); color: var(--ink-2); }
.tpl-stages, .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.describe { grid-template-columns: auto 1fr; align-items: center; gap: 12px; }
.describe-text { display: grid; gap: 2px; }
.other summary { cursor: pointer; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); padding: 4px 0; }
.other-body { display: grid; gap: 10px; padding-top: 8px; }
.check > span { display: grid; gap: 1px; }
.check b { font-weight: 600; }
.n { margin-left: 4px; font-weight: 400; font-size: var(--t-sm); color: var(--ink-2); }
.presets { display: grid; gap: 10px; max-height: min(220px, 28dvh); overflow-y: auto; padding: 8px 2px 10px; border-block: 1px solid var(--line); }
.gone { display: flex; align-items: center; gap: 6px; font-size: var(--t-sm); color: var(--warn); font-weight: 500; }
.copy-from { margin-left: 28px; width: calc(100% - 28px); }
.tip { display: grid; grid-template-columns: auto 1fr; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--accent-tint); color: var(--accent-ink); font-size: var(--t-sm); }

.sumrow { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
.sumrow dt { font-size: var(--t-sm); color: var(--ink-3); }
.sumrow dd { margin: 0; display: grid; gap: 2px; justify-items: start; }
.clip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); }
.link { border: 0; padding: 0; background: none; font: inherit; font-size: var(--t-sm); font-weight: 600; color: var(--accent-ink); cursor: pointer; }
.link:hover { text-decoration: underline; }

.aside { display: grid; gap: 14px; align-content: start; padding: 24px; background: var(--sunk); border-left: 1px solid var(--line); overflow-y: auto; }
.aside h4 { font-size: var(--t-lg); font-weight: 600; }
.later { display: grid; gap: 6px; }
.tabmap { display: flex; gap: 4px; padding: 4px; background: var(--surface); border-radius: 12px; border: 1px solid var(--line); }
.tabmap span { flex: 1; padding: 6px 0; border-radius: 8px; text-align: center; font-size: var(--t-xs); font-weight: 600; color: var(--ink-3); }
.tabmap .lit { background: var(--ink); color: #fff; }
/* step 1: each tab lights in turn with its caption; at rest (reduced motion) all four captions show as a list */
.cycle span { animation: tab-cycle calc(var(--t-move) * 36) var(--ease) infinite; }
.cycle span:nth-child(2), .cap span:nth-child(2) { animation-delay: calc(var(--t-move) * 9); }
.cycle span:nth-child(3), .cap span:nth-child(3) { animation-delay: calc(var(--t-move) * 18); }
.cycle span:nth-child(4), .cap span:nth-child(4) { animation-delay: calc(var(--t-move) * 27); }
@keyframes tab-cycle { 0%, 22% { background: var(--ink); color: #fff; } 25%, 100% { background: transparent; color: var(--ink-3); } }
.cap { position: relative; height: 20px; font-size: var(--t-sm); color: var(--ink-2); }
.cap span { position: absolute; inset: 0; opacity: 0; animation: cap-cycle calc(var(--t-move) * 36) infinite; }
.cap b { display: none; }
@keyframes cap-cycle { 0%, 22% { opacity: 1; } 25%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .cap { height: auto; display: grid; gap: 4px; }
  .cap span { position: static; opacity: 1; }
  .cap b { display: inline; color: var(--ink); }
  .tpl { transition: none; }
}
.preview { display: grid; gap: 8px; padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); }
.preview b { font-size: var(--t-lg); overflow-wrap: anywhere; }
.preview .chips { margin-top: 0; }
.bar { height: 6px; border-radius: 3px; background: var(--sunk); }
.bar.short { width: 80%; }
.preview .btn { justify-self: start; pointer-events: none; }
.next { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start; }
.next i { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); font-style: normal; font-weight: 700; font-size: var(--t-xs); }
.next > span { display: grid; gap: 2px; }

.foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 16px 28px; border-top: 1px solid var(--line); }
.foot-right { display: flex; gap: 8px; align-items: center; margin-left: auto; }
@media (max-width: 760px) {
  .body { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .main, .aside { overflow: visible; }
  .aside { border-left: 0; border-top: 1px solid var(--line); }
  .tpls, .grid2 { grid-template-columns: minmax(0, 1fr); }
}
</style>
