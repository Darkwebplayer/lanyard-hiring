<script setup lang="ts">
// First-run setup for the admin: company, team, their own hours, then the first job.
// Opens by itself once, while the company has no name; later from the me-menu ("Set up Lanyard").
interface Settings { companyName: string | null, replyToEmail: string | null, aiEnabled: boolean, [k: string]: unknown }
interface Role { id: string, name: string, level: 'manager' | 'employee' }
type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri'

const { me } = useMe()
const { seen, markSeen } = useSeen()
const setup = useSetup()
const checked = useSetupChecked()
const touring = useTour()

const dlg = ref<HTMLDialogElement>()
const step = ref(1)
const busy = ref(false)
const error = ref('')
const LABELS = ['Company', 'Team', 'Your hours', 'First job']
const ROLE_VIEW = [
  { name: 'Admin', sees: ['Everything', 'Team', 'Settings'] },
  { name: 'Manager', sees: ['Jobs', 'Candidates', 'Reports'] },
  { name: 'Employee', sees: ['Their tasks', 'Their availability'] },
]

onMounted(async () => {
  if (seen('setup')) return
  // a company that already has a name was set up before this wizard existed (or on another device)
  const s = await api<Settings>('/api/settings').catch(() => null)
  if (!s) return
  if (s.companyName) { markSeen('setup'); checked.value = true }
  else setup.value = true
})
watch(setup, (o) => {
  if (o && !dlg.value?.open) { reset(); dlg.value?.showModal(); load() }
  if (!o && dlg.value?.open) dlg.value.close()
})
// every way out (Do this later, Esc, the last step's buttons) lands here
function onClose() {
  markSeen('setup')
  setup.value = false
}

// ---------- what was done, for the checklist ----------
const done = reactive({ company: false, invited: [] as { email: string, role: string }[], hours: false })
function reset() {
  step.value = 1
  error.value = ''
  Object.assign(done, { company: false, invited: [], hours: false })
  rows.value = [{ email: '', roleId: '' }]
}

// ---------- 1 company ----------
const showAi = computed(() => me.value?.ai !== 'unconfigured')
const company = reactive({ name: '', reply: '', ai: true })
const roles = ref<Role[]>([])
const hadHours = ref(false)
async function load() {
  const [s, r, a] = await Promise.all([
    api<Settings>('/api/settings').catch(() => null),
    api<Role[]>('/api/roles').catch(() => []),
    api<{ timezone: string | null }>('/api/me/availability').catch(() => null),
  ])
  if (s) Object.assign(company, { name: s.companyName ?? '', reply: s.replyToEmail ?? '', ai: s.aiEnabled })
  roles.value = r
  hadHours.value = !!a?.timezone
  if (a?.timezone) timezone.value = a.timezone
}
async function saveCompany() {
  if (!company.name.trim()) throw new Error('Add your company name, or skip this for now.')
  // read again just before writing, so the other settings go back exactly as they are
  const s = await api<Settings>('/api/settings')
  await api('/api/settings', {
    method: 'PUT',
    body: { ...s, companyName: company.name.trim(), replyToEmail: company.reply.trim() || null, ...(showAi.value && { aiEnabled: company.ai }) },
  })
  // Use AI decides who sees Ask, so read "me" again (as Settings does)
  me.value = await api<Me>('/api/me').catch(() => me.value)
  done.company = true
}

// ---------- 2 team ----------
const rows = ref([{ email: '', roleId: '' }])
const rowErrors = ref<string[]>([])
const defaultRole = computed(() => roles.value.find(r => r.level === 'employee')?.id ?? roles.value[0]?.id ?? '')
// a fresh company has no roles, and an invite needs one: start with the two most small teams use
async function ensureRoles() {
  if (roles.value.length) return
  for (const r of [{ name: 'Hiring manager', level: 'manager' }, { name: 'Interviewer', level: 'employee' }]) {
    roles.value.push(await api<Role>('/api/roles', { method: 'POST', body: r }))
  }
}
watch(step, async (s) => {
  if (s !== 2) return
  try { await ensureRoles() }
  catch (e) { error.value = toApiError(e).message }
  for (const r of rows.value) r.roleId ||= defaultRole.value
})
const addRow = () => rows.value.push({ email: '', roleId: defaultRole.value })
async function sendInvites() {
  rowErrors.value = []
  const left: typeof rows.value = []
  for (const r of rows.value) {
    if (!r.email.trim()) continue
    try {
      const inv = await api<{ email: string, roleName: string }>('/api/invites', { method: 'POST', body: { email: r.email.trim(), roleId: r.roleId } })
      done.invited.push({ email: inv.email, role: inv.roleName })
    }
    catch (e) {
      rowErrors.value[left.length] = toApiError(e).message
      left.push(r)
    }
  }
  // the ones that failed stay, with their reason, so nothing typed is lost
  rows.value = left.length ? left : [{ email: '', roleId: defaultRole.value }]
  if (left.length) throw new Error(left.length === 1 ? 'One invite didn’t go. Fix it, or skip for now.' : `${left.length} invites didn’t go. Fix them, or skip for now.`)
}

// ---------- 3 hours ----------
const here = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = (() => {
  try { return Intl.supportedValuesOf('timeZone') }
  catch { return [here] }
})()
const timezone = ref(here)
const WEEK: { key: Day, label: string }[] = [{ key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' }, { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }]
const on = reactive<Record<Day, boolean>>({ mon: true, tue: true, wed: true, thu: true, fri: true })
const clock = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const nineToFive = `${clock(9)} – ${clock(17)}`
async function saveHours() {
  const days = WEEK.filter(d => on[d.key])
  if (!days.length) throw new Error('Turn on at least one day, or skip for now.')
  await api('/api/me/availability', { method: 'PUT', body: { timezone: timezone.value, hours: Object.fromEntries(days.map(d => [d.key, [['09:00', '17:00']]])) } })
  done.hours = true
}
const daysText = computed(() => {
  const d = WEEK.filter(x => on[x.key])
  return d.length === 5 ? 'Weekdays' : d.map(x => x.label).join(', ')
})

// ---------- moving between steps ----------
const primaryLabel = computed(() => step.value === 2 ? (rows.value.some(r => r.email.trim()) ? 'Send invites' : 'Next') : step.value === 3 && !hadHours.value ? 'Save availability' : 'Next')
async function primary() {
  error.value = ''
  busy.value = true
  try {
    if (step.value === 1) await saveCompany()
    else if (step.value === 2) await sendInvites()
    else if (step.value === 3 && !hadHours.value) await saveHours()
    step.value++
  }
  catch (e) { error.value = e instanceof Error ? e.message : toApiError(e).message }
  finally { busy.value = false }
}
const skip = () => { error.value = ''; step.value++ }
const back = () => { error.value = ''; step.value-- }

// leave first, then close: closing on the inbox would let the tour start under the next page
async function leave(to: string) {
  await navigateTo(to)
  dlg.value?.close()
}
const firstJob = () => leave('/jobs?new=first')
function tour() {
  dlg.value?.close()
  touring.value = true
}
</script>

<template>
  <dialog ref="dlg" class="dialog setup" aria-labelledby="setup-h" @close="onClose">
    <header class="head">
      <div class="top">
        <div class="name"><span class="badge" aria-hidden="true" /><h2 id="setup-h">Set up Lanyard</h2></div>
        <button type="button" class="btn btn-quiet" @click="dlg?.close()">Do this later</button>
      </div>
      <ol class="steps" aria-label="Progress">
        <li v-for="(l, i) in LABELS" :key="l" :class="{ done: i + 1 < step, on: i + 1 === step }" :aria-current="i + 1 === step ? 'step' : undefined">
          <i>{{ i + 1 < step ? '✓' : i + 1 }}</i>{{ l }}
        </li>
      </ol>
    </header>

    <form class="mid" novalidate @submit.prevent="primary">
      <section class="main">
        <template v-if="step === 1">
          <div class="lead"><h3>Company profile</h3><p class="faint">Candidates see this name on every apply page and email.</p></div>
          <div class="field">
            <label for="su-name">Company name</label>
            <input id="su-name" v-model="company.name" maxlength="200" autocomplete="organization" placeholder="Northwind Logistics" autofocus>
          </div>
          <div class="field">
            <label for="su-reply">Reply-to email</label>
            <input id="su-reply" v-model="company.reply" type="email" placeholder="hiring@company.com">
          </div>
          <label v-if="showAi" class="panel ai-row">
            <input v-model="company.ai" type="checkbox" role="switch" class="switch">
            <span><b>Use AI to read and score CVs</b><br><span class="faint">You can turn it off any time in Settings.</span></span>
          </label>
        </template>

        <template v-else-if="step === 2">
          <div class="lead"><h3>Team members</h3><p class="faint">Invite them now, or skip and do it from Team later.</p></div>
          <div class="invites">
            <div class="row heads" aria-hidden="true"><span>Email</span><span>They can</span><span /></div>
            <div v-for="(r, i) in rows" :key="i" class="row-wrap">
              <div class="row">
                <input v-model="r.email" type="email" :aria-label="`Email ${i + 1}`" placeholder="name@company.com" :aria-invalid="!!rowErrors[i] || undefined">
                <select v-model="r.roleId" :aria-label="`Role for person ${i + 1}`">
                  <option v-for="ro in roles" :key="ro.id" :value="ro.id">{{ ro.name }} ({{ ro.level }})</option>
                </select>
                <button v-if="rows.length > 1" type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Remove person ${i + 1}`" @click="rows.splice(i, 1); rowErrors.splice(i, 1)"><Icon name="x" :size="16" /></button>
              </div>
              <p v-if="rowErrors[i]" class="row-err">{{ rowErrors[i] }}</p>
            </div>
            <button v-if="rows.length < 10" type="button" class="btn btn-quiet btn-sm add" @click="addRow"><Icon name="plus" />Add someone</button>
          </div>
          <p v-if="done.invited.length" class="ok"><Icon name="check" :size="14" />Invited {{ done.invited.map(x => x.email).join(', ') }}</p>
          <p class="faint">They get an email and sign in with Google.</p>
        </template>

        <template v-else-if="step === 3">
          <div class="lead"><h3>Interview availability</h3><p class="faint">Candidates pick a time from these hours. Without hours, nobody can book you.</p></div>
          <p v-if="hadHours" class="panel note">You’ve set your hours already. Change them on the <NuxtLink to="/inbox/hours" @click.prevent="leave('/inbox/hours')">full hours page</NuxtLink>.</p>
          <template v-else>
            <div class="field tz">
              <label for="su-tz">Time zone</label>
              <select id="su-tz" v-model="timezone">
                <option v-for="z in zones" :key="z" :value="z">{{ z.replaceAll('_', ' ') }}</option>
              </select>
            </div>
            <ul class="days">
              <li v-for="d in WEEK" :key="d.key" class="day">
                <label class="day-on"><input v-model="on[d.key]" type="checkbox" role="switch" class="switch" :aria-label="`Available on ${d.label}`"><b>{{ d.label }}</b></label>
                <span :class="{ faint: !on[d.key] }">{{ on[d.key] ? nineToFive : 'Not available' }}</span>
              </li>
            </ul>
            <NuxtLink to="/inbox/hours" class="go" @click.prevent="leave('/inbox/hours')">Need split hours or weekends? Use the full availability page</NuxtLink>
          </template>
        </template>

        <template v-else>
          <div class="lead"><h3>Setup complete</h3><p class="faint">One thing left: the job you’re hiring for.</p></div>
          <ul class="checks">
            <li><i :class="{ no: !done.company }">{{ done.company ? '✓' : 1 }}</i><span>
              <b>{{ done.company ? company.name : 'Your company' }}</b><br>
              <span class="faint">{{ done.company ? [company.reply && `Replies go to ${company.reply}`, showAi && `AI ${company.ai ? 'on' : 'off'}`].filter(Boolean).join(' · ') || 'Saved' : 'Skipped. Add it any time in Settings.' }}</span>
            </span></li>
            <li><i :class="{ no: !done.invited.length }">{{ done.invited.length ? '✓' : 2 }}</i><span>
              <b>{{ done.invited.length ? `${plural(done.invited.length, 'person', 'people')} invited` : 'Your team' }}</b><br>
              <span class="faint">{{ done.invited.length ? done.invited.map(x => `${x.email.split('@')[0]} · ${x.role}`).join(', ') : 'Skipped. Invite people from Team.' }}</span>
            </span></li>
            <li><i :class="{ no: !done.hours && !hadHours }">{{ done.hours || hadHours ? '✓' : 3 }}</i><span>
              <b>Your hours</b><br>
              <span class="faint">{{ done.hours ? `${daysText}, ${nineToFive}, ${timezone.replaceAll('_', ' ')} time` : hadHours ? 'Already set' : 'Skipped. Set them from Inbox → Interview availability.' }}</span>
            </span></li>
            <li><i class="no">4</i><span><b>Your first job</b><br><span class="faint">Two minutes, step by step</span></span></li>
          </ul>
        </template>

        <p v-if="error" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ error }}</p>
      </section>

      <aside class="side">
        <template v-if="step === 1">
          <template v-if="showAi">
            <p class="eyebrow">AI on or off</p>
            <div class="ab" role="img" aria-label="With AI, applications are sorted for you. Without AI, you read every one.">
              <div><b>On</b><span class="pile ai" aria-hidden="true"><span v-for="n in 10" :key="n" /></span><span class="faint">Strong CVs are lit up. You read those first.</span></div>
              <div><b>Off</b><span class="pile" aria-hidden="true"><span v-for="n in 10" :key="n" /></span><span class="faint">You read every one.</span></div>
            </div>
            <p class="faint">The AI only suggests. A person always decides who is hired.</p>
          </template>
          <p v-else class="faint">AI isn’t set up on this server. Lanyard works without it: you read every application yourself.</p>
          <div class="later"><p class="eyebrow">Later, change it in</p><span class="faint"><b>Settings</b> in the left menu</span></div>
        </template>
        <template v-else-if="step === 2">
          <p class="eyebrow">Who sees what</p>
          <div class="roles" role="img" aria-label="Admins see everything. Managers run jobs. Employees see only their interview tasks.">
            <div v-for="r in ROLE_VIEW" :key="r.name" class="role"><span class="badge" aria-hidden="true" /><b>{{ r.name }}</b><ul><li v-for="x in r.sees" :key="x">{{ x }}</li></ul></div>
          </div>
          <p class="faint">An interviewer only sees the people they’re asked to score. Not the whole pipeline.</p>
          <div class="later"><p class="eyebrow">Later, change it in</p><span class="faint"><b>Team</b> in the left menu</span></div>
        </template>
        <template v-else-if="step === 3">
          <p class="eyebrow">What the candidate sees</p>
          <div class="panel booking" role="img" aria-label="The candidate gets a link and picks one free slot inside your hours.">
            <b>Pick a time for your interview</b>
            <div class="week" aria-hidden="true">
              <em /><b>M</b><b>T</b><b>W</b><b>T</b><b>F</b>
              <template v-for="h in ['9', '10', '11', '2', '3']" :key="h">
                <em>{{ h }}</em><span v-for="d in 5" :key="d" :class="{ pick: h === '10' && d === 3 }" />
              </template>
            </div>
            <span class="faint">Booked: Wed 10:00 AM. It goes into your inbox.</span>
          </div>
          <div class="later"><p class="eyebrow">Later, change it in</p><span class="faint"><b>Inbox → Interview availability</b></span></div>
        </template>
        <template v-else>
          <p class="eyebrow">Where things live</p>
          <div class="panel places">
            <span><b>Inbox</b> · your tasks, like scorecards</span>
            <span><b>Jobs</b> · each job and its candidates</span>
            <span><b>Templates</b> · steps, workflows and letters you reuse</span>
            <span><b>Reports</b> · who you hired, and from where</span>
          </div>
          <p class="faint">Press <span class="kbd">?</span> on any page to see how it works.</p>
        </template>
      </aside>

      <footer class="foot">
        <button v-if="step > 1" type="button" class="btn" :disabled="busy" @click="back">Back</button>
        <span v-else class="faint">Four short steps.</span>
        <div class="acts">
          <template v-if="step < 4">
            <button type="button" class="btn btn-quiet" :disabled="busy" @click="skip">Skip for now</button>
            <button class="btn btn-primary" :disabled="busy" :aria-busy="busy"><span v-if="busy" class="spinner" /><span>{{ primaryLabel }}</span></button>
          </template>
          <template v-else>
            <button type="button" class="btn" @click="tour">Show me around first</button>
            <button type="button" class="btn btn-primary" @click="firstJob">Create your first job</button>
          </template>
        </div>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
dialog.setup { width: min(960px, calc(100vw - 32px)); height: min(720px, calc(100dvh - 32px)); max-height: none; overflow: hidden; }
dialog.setup[open] { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.head { padding: 22px 28px 18px; display: grid; gap: 14px; border-bottom: 1px solid var(--line); }
.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.name { display: flex; gap: 12px; align-items: center; }
.name h2 { font-size: var(--t-xl); }
.badge { position: relative; width: 24px; height: 30px; border-radius: 6px; background: var(--ink); flex: none; }
.badge::before { content: ""; position: absolute; top: 4px; left: 50%; translate: -50% 0; width: 10px; height: 3px; border-radius: 2px; background: var(--accent); }

.mid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; grid-template-rows: minmax(0, 1fr) auto; min-height: 0; }
.main { padding: 28px; display: grid; gap: 20px; align-content: start; overflow-y: auto; }
.lead { display: grid; gap: 6px; }
.lead h3 { font-size: var(--t-xl); }
.side { padding: 24px; display: grid; gap: 14px; align-content: start; overflow-y: auto; background: var(--sunk); border-left: 1px solid var(--line); font-size: var(--t-sm); }
.side b { color: var(--ink); }
.later { display: grid; gap: 6px; }
.foot { grid-column: 1 / -1; padding: 16px 28px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.acts { display: flex; gap: 8px; }

/* the switch: the same one the hours page uses */
.switch { width: 38px; height: 24px; border-radius: 99px; border: 2px solid transparent; background: var(--line-2) padding-box; position: relative; flex: none; appearance: none; margin: 0; cursor: pointer; }
.switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px oklch(0.3 0.04 330 / 0.3); transition: translate var(--t-micro) var(--ease); }
.switch:checked { background: var(--ink) padding-box; }
.switch:checked::before { translate: 14px 0; }
.ai-row { display: flex; gap: 14px; align-items: center; padding: 14px 16px; cursor: pointer; line-height: 1.4; }

.invites { display: grid; gap: 10px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) 220px 30px; gap: 8px; align-items: center; }
.heads { font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.row-wrap { display: grid; gap: 4px; }
.row-err { font-size: var(--t-sm); color: var(--bad); font-weight: 500; }
.add { justify-self: start; margin-left: -8px; color: var(--accent-ink); }
.ok { display: flex; gap: 6px; align-items: center; color: var(--ok); font-size: var(--t-sm); font-weight: 500; }

.tz { max-width: 320px; }
.days { list-style: none; margin: 0; padding: 0; }
.day { display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); }
.day-on { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.go { color: var(--accent-ink); font-size: var(--t-sm); font-weight: 600; justify-self: start; }
.note { padding: 12px 16px; }
.note a { color: var(--accent-ink); font-weight: 600; }

.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.checks li { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; line-height: 1.4; }
.checks i { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: var(--t-xs); font-weight: 600; background: var(--ok); color: #fff; }
.checks i.no { background: var(--sunk); color: var(--ink-3); }

/* AI on/off: the lit pile is the one the AI sorted */
.ab { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ab > div { display: grid; gap: 6px; align-content: start; padding: 12px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); font-size: var(--t-xs); }
.pile { display: flex; gap: 3px; flex-wrap: wrap; }
.pile span { width: 14px; height: 18px; border-radius: 3px; background: var(--line-2); }
.pile.ai span { animation: sort 4s var(--ease) infinite; background: var(--accent); }
.pile.ai span:nth-child(odd) { animation-delay: 0.4s; }
.pile.ai span:nth-child(3n) { animation-delay: 0.8s; }
.pile.ai span:nth-child(4n) { animation-name: sortno; background: var(--sunk); }
@keyframes sort { 0%, 30% { background: var(--line-2); } 45%, 100% { background: var(--accent); } }
@keyframes sortno { 0%, 30% { background: var(--line-2); } 45%, 100% { background: var(--sunk); } }

.roles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.role { display: grid; gap: 8px; justify-items: center; padding: 12px 6px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); animation: lit 9s var(--ease) infinite; }
.role:nth-child(2) { animation-delay: 3s; }
.role:nth-child(3) { animation-delay: 6s; }
@keyframes lit { 0%, 30% { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); } 33%, 100% { border-color: var(--line); box-shadow: none; } }
.role .badge { width: 30px; height: 38px; border-radius: 7px; }
.role .badge::before { top: 5px; width: 12px; }
.role ul { list-style: none; margin: 0; padding: 0; font-size: var(--t-xs); color: var(--ink-2); text-align: center; display: grid; gap: 2px; }

.booking { display: grid; gap: 10px; padding: 16px; }
.week { display: grid; grid-template-columns: 28px repeat(5, 1fr); gap: 3px; font-size: 11px; color: var(--ink-3); }
.week span { height: 16px; border-radius: 3px; background: var(--accent-tint); }
.week em { font-style: normal; text-align: right; padding-right: 4px; }
.week b { text-align: center; font-weight: 600; color: var(--ink-3); }
.week .pick { animation: book 5s var(--ease) infinite; background: var(--accent); }
@keyframes book { 0%, 40% { background: var(--accent-tint); } 50%, 90% { background: var(--accent); } 100% { background: var(--accent-tint); } }
.places { display: grid; gap: 10px; padding: 16px; }

@media (width < 860px) {
  .mid { grid-template-columns: minmax(0, 1fr); }
  .side { display: none; }
}
</style>
