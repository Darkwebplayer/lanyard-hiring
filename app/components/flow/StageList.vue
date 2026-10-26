<script setup lang="ts">
import { fieldsAvailableAt } from '~~/shared/workflow/graph'
import type { HumanTaskConfig } from '~~/shared/workflow/registry'
import { type StageExit, type StageInfo, type StageStep, type StageView, candidateSteps, removeStep, stageView } from '~~/shared/workflow/stages'
import type { FormField, Graph, Issue } from '~~/shared/workflow/types'
import { type PaletteItem, type Person, type Role, issueText, onlySome, ruleWords, summaryOf, titleOf } from '~/lib/flow'
import type { PipelineState } from '~/pages/jobs/[id].vue'
import AskFields from './AskFields.vue'

// The flow read as the board's columns: what happens when someone arrives in each stage, who works there,
// and where people go next. Edits go up to FlowEditor, which owns the draft, history and autosave.
const props = defineProps<{
  graph: Graph, view: StageView, form: FormField[], issuesBy: Map<string, Issue[]>, roles: Role[], people: Person[] | null
  selectedKey: string | null, readOnly: boolean, formHref: string, palette: { key: string, group: string, items: PaletteItem[] }[]
}>()
const emit = defineEmits<{
  select: [key: string | null], add: [stageId: string, kind: 'auto' | 'people', item: PaletteItem], remove: [key: string]
  rename: [id: string, name: string], move: [id: string, dir: -1 | 1], removeStage: [id: string], addStage: [at: number]
}>()

const node = (k: string) => props.graph.nodes.find(n => n.key === k)
const name = (k: string) => { const n = node(k); return n ? titleOf(n) : k }
const stageName = (id: string | null) => props.view.stages.find(s => s.id === id)?.name ?? ''
const paletteFor = (kind: 'auto' | 'people') => props.palette.find(g => g.key === (kind === 'auto' ? 'system' : 'person'))?.items ?? []

// ---------- rows ----------
function personLine(st: StageStep) {
  const c = (node(st.key)?.config ?? {}) as Partial<HumanTaskConfig> & { booking?: { duration_min: number } }
  const a = c.assignees
  const who = [
    a?.job_owner && 'Job owner',
    ...(a?.roles ?? []).map(id => props.roles.find(r => r.id === id)?.name ?? 'a role'),
    ...(a?.users ?? []).map(id => props.people?.find(p => p.id === id)?.name ?? 'someone'),
  ].filter(Boolean).join(', ') || 'Nobody yet'
  const panel = (c.min_submissions ?? 1) > 1 ? `${c.min_submissions} score it` : ''
  const due = c.due_days === undefined ? '' : c.due_days === 0 ? 'due the same day' : `due in ${plural(c.due_days, 'day')}`
  const book = c.booking ? `candidate books ${c.booking.duration_min} min` : ''
  return { who: [who, panel, due, book].filter(Boolean).join(' · '), asks: (c.scorecard ?? []).map(q => q.label).filter(Boolean).join(' · ') }
}
const autoText = (st: StageStep) => st.effects[0]?.text ?? name(st.key)
const autoSub = (st: StageStep) => { const n = node(st.key); return n ? summaryOf(n, props.form, props.roles) : '' }
const removable = (k: string) => !props.readOnly && !!removeStep(props.graph, k)
// "What's this?" beside the two places people misread: person steps (only some reach them) and a stage with two emails (only one is sent)
const { show: showHelp } = useHelp()
const twoEmails = (s: StageInfo) => s.auto.filter(st => st.type === 'send_email').length > 1
// person steps a decision sends only some people to ("Only AI review: Overall score 40–69")
const only = (k: string) => {
  const from = props.graph.edges.find(e => e.to === k)?.from
  return from ? onlySome(props.graph, k, fieldsAvailableAt(props.graph, from, props.form)) : null
}
// a stage of emails sends each person one of them: say which branch of the stage before leads to which email
function oneWay(i: number) {
  const s = props.view.stages[i]!
  const prev = props.view.stages[i - 1]
  if (!prev || !twoEmails(s) || !s.auto.every(st => st.type === 'send_email')) return null
  return new Map(s.auto.map((st) => {
    const ins = exitsOf(prev).filter(x => !('closed' in x.to) && x.to.node === st.key)
    const end = node(props.graph.edges.find(e => e.from === st.key)?.to ?? '')
    const out = end?.type === 'end' ? OUT[(end.config as { outcome: keyof typeof OUT }).outcome] : ''
    const when = ins.length ? [...new Set(ins.map(exitWhen))].join(' or ') : 'From an earlier stage'
    return [st.key, `${when} → sends “${name(st.key)}”${out ? ` → ${out}` : ''}`]
  }))
}

// ---------- exits: in words, without the moves that stay inside the stage ----------
const exitsOf = (s: StageInfo) => s.exits.filter(x => 'closed' in x.to || x.to.stage !== s.id)
function exitWhen(x: StageExit) {
  if (x.rule && x.condition) return ruleWords(x.rule, fieldsAvailableAt(props.graph, x.condition, props.form))
  if (x.label === 'Otherwise') return 'Otherwise'
  if (x.label === 'Missing data') return 'When there’s no answer or score to decide on'
  return x.label ?? 'When their step here is done'
}
const OUT = { hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn' } as const
const dest = (x: StageExit) => 'closed' in x.to
  ? { text: OUT[x.to.closed], cls: x.to.closed === 'hired' ? 'chip-ok' : 'chip-bad' }
  : { text: stageName(x.to.stage) || name(x.to.node), cls: 'chip-ink' }
const conditionIssues = (s: StageInfo) => [...new Set(exitsOf(s).map(x => x.condition).filter(Boolean) as string[])]
  .flatMap(k => (props.issuesBy.get(k) ?? []).map(i => ({ key: k, text: `${name(k)}: ${issueText(i, props.graph)}` })))
const stepIssues = (k: string) => (props.issuesBy.get(k) ?? []).map(i => issueText(i, props.graph))
const stageHasIssues = (s: StageInfo) => [...s.auto, ...s.people].some(x => props.issuesBy.has(x.key)) || conditionIssues(s).length > 0
const isOn = (s: StageInfo) => [...s.auto, ...s.people].some(x => x.key === props.selectedKey) || s.exits.some(x => x.condition === props.selectedKey)

// ---------- stage actions: each one checked against the stage list, so an edit never turns it into a wrong list ----------
const stages = computed(() => props.graph.stages ?? [])
function moveBlocker(i: number, dir: -1 | 1) {
  const list = [...stages.value]
  if (!list[i + dir]) return 'Already at the end'
  list.splice(i + dir, 0, ...list.splice(i, 1))
  return stageView({ ...props.graph, stages: list }).fits ? '' : 'People would move back into an earlier stage'
}
function deleteBlocker(i: number) {
  const s = stages.value[i]!
  if (!s.nodeKeys.length) return ''
  const into = stages.value[i - 1] ?? stages.value[i + 1]
  if (!into) return 'It’s the only stage, and its steps need one'
  const list = stages.value.filter(x => x !== s).map(x => x === into ? { ...x, nodeKeys: [...x.nodeKeys, ...s.nodeKeys] } : x)
  return stageView({ ...props.graph, stages: list }).fits ? '' : 'Its steps can’t join the stage next to it'
}
function rename(id: string, e: Event) {
  const input = e.target as HTMLInputElement
  const v = input.value.trim()
  if (v && v !== stageName(id)) emit('rename', id, v)
  else input.value = stageName(id)
}
// what candidates see on their status page; empty reads "In review", so internal names never reach them
const candidateNameOf = (id: string) => stages.value.find(s => s.id === id)?.candidateName ?? ''
const hiddenFromCandidates = computed(() => candidateSteps(props.graph).hidden)
function setCandidateName(id: string, e: Event) {
  const st = stages.value.find(s => s.id === id)!
  const v = (e.target as HTMLInputElement).value.trim()
  if (v) st.candidateName = v
  else delete st.candidateName
}
const askOf = (id: string) => stages.value.find(s => s.id === id)?.ask ?? []
function setAsk(id: string, v: FormField[]) {
  const st = stages.value.find(s => s.id === id)!
  if (v.length) st.ask = v
  else delete st.ask
}

// a new stage opens with its name selected, ready to type over
const root = ref<HTMLElement>()
watch(() => stages.value.map(s => s.id), async (ids, was) => {
  const fresh = ids.find(id => !was.includes(id))
  if (!fresh || ids.length <= was.length) return
  await nextTick()
  const input = root.value?.querySelector<HTMLInputElement>(`#st-name-${fresh}`)
  input?.focus()
  input?.select()
})
// closing the step's panel puts focus back on its row
watch(() => props.selectedKey, async (now, was) => {
  if (now || !was) return
  await nextTick()
  root.value?.querySelector<HTMLElement>(`[data-step="${was}"]`)?.focus()
})

// ---------- board preview: today's counts per column, from the hub ----------
const pipeline = inject<PipelineState | null>('pipeline', null)
const hereIn = (id: string) => {
  const keys = stages.value.find(s => s.id === id)?.nodeKeys ?? []
  return pipeline?.board.value?.counts.filter(c => c.status === 'active' && c.key && keys.includes(c.key)).reduce((n, c) => n + c.n, 0)
}
const closedCount = computed(() => pipeline?.board.value?.counts.filter(c => c.status === 'closed').reduce((n, c) => n + c.n, 0))
const formCount = computed(() => props.form.length)

// ---------- closed ----------
// The emails a flow sends on its way into each outcome. Closing someone by hand sends none.
function closedLine(c: StageView['closed'][number]) {
  const emails = [...new Set(props.graph.edges.filter(e => c.ends.includes(e.to)).map(e => node(e.from)).filter(n => n?.type === 'send_email').map(n => `“${titleOf(n!)}”`))]
  if (!c.ends.length) return 'Only when you close someone by hand'
  return emails.length ? `Sends ${emails.join(' or ')} on the way` : 'The workflow can end here'
}
</script>

<template>
  <div ref="root" class="stage-editor" :class="{ narrow: !!selectedKey }">
    <div class="list">
      <h3 class="sr-only">Stages</h3>
      <section class="st applied card" aria-label="Applied">
        <div class="st-head">
          <span class="num ok" aria-hidden="true"><Icon name="check" :size="14" /></span>
          <b class="st-title">Applied</b>
          <span class="meta">Apply form · {{ formCount ? plural(formCount, 'question') : 'name and contact details only' }}</span>
          <NuxtLink :to="formHref" class="meta-link">Edit form</NuxtLink>
        </div>
      </section>

      <template v-for="(s, i) in view.stages" :key="s.id">
        <div class="join">
          <i aria-hidden="true" />
          <button v-if="!readOnly" type="button" class="add-stage" @click="emit('addStage', i)"><Icon name="plus" :size="14" />Add a stage</button>
        </div>

        <section
          class="st card" :class="{ on: isOn(s), bad: stageHasIssues(s) }" :data-slot="s.people.length ? 'accent' : 'ink'"
          :aria-labelledby="`st-name-${s.id}`"
        >
          <div class="st-head">
            <span class="num" aria-hidden="true">{{ i + 1 }}</span>
            <input
              :id="`st-name-${s.id}`" class="st-name" :value="s.name" maxlength="40" :disabled="readOnly" :aria-label="`Stage ${i + 1} name`"
              @change="rename(s.id, $event)" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            >
            <span v-if="!s.people.length && (s.auto.length)" class="chip">Automatic</span>
            <span v-if="hereIn(s.id) !== undefined" class="here">{{ hereIn(s.id) }} here</span>
            <span v-if="!readOnly" class="st-tools">
              <button
                v-for="d in ([-1, 1] as const)" :key="d" type="button" class="btn btn-quiet btn-icon btn-sm"
                :aria-label="`Move ${s.name} ${d < 0 ? 'up' : 'down'}`" :aria-disabled="!!moveBlocker(i, d)" :title="moveBlocker(i, d) || (d < 0 ? 'One column left on the board' : 'One column right on the board')"
                @click="!moveBlocker(i, d) && emit('move', s.id, d)"
              ><Icon :name="d < 0 ? 'arrow-up' : 'arrow-down'" :size="14" /></button>
              <button
                type="button" class="btn btn-quiet btn-icon btn-sm" :aria-label="`Delete stage ${s.name}`"
                :aria-disabled="!!deleteBlocker(i)" :title="deleteBlocker(i) || (s.auto.length + s.people.length ? 'Delete stage; its steps join the stage next to it' : 'Delete stage')"
                @click="!deleteBlocker(i) && emit('removeStage', s.id)"
              ><Icon name="trash" :size="14" /></button>
            </span>
          </div>

          <label v-if="!hiddenFromCandidates.has(s.id)" class="cand">
            <span>Candidates see</span>
            <input :value="candidateNameOf(s.id)" placeholder="In review" maxlength="40" :disabled="readOnly" @change="setCandidateName(s.id, $event)" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()">
          </label>
          <p v-else class="cand-off">Candidates don’t see this stage. They hear about it by email.</p>

          <p v-if="!s.auto.length && !s.people.length" class="empty-stage">Nobody stops here yet. Add a step, or delete the stage.</p>

          <div v-if="s.auto.length" class="blk">
            <div class="lbl-row">
              <h4 class="lbl">Automated actions <span class="lbl-hint">· when someone arrives</span></h4>
              <button v-if="twoEmails(s)" type="button" class="what" aria-label="What’s this? Why only one of these emails is sent" @click="showHelp('stages')">What’s this?</button>
            </div>
            <p v-if="oneWay(i)" class="sub">Goes <b>one</b> way, depending on what happened in {{ view.stages[i - 1]!.name }}:</p>
            <div v-for="st in s.auto" :key="st.key" class="row-wrap">
              <div class="act" :class="{ sel: st.key === selectedKey, bad: issuesBy.has(st.key) }">
                <button type="button" class="act-main" :data-step="st.key" @click="emit('select', st.key)">
                  <span class="ic" aria-hidden="true"><Icon :name="nodeMeta(st.type).icon" :size="14" /></span>
                  <b class="act-name">{{ oneWay(i)?.get(st.key) ?? autoText(st) }}</b>
                  <span v-if="!oneWay(i)" class="sub">{{ autoSub(st) }}</span>
                </button>
                <button
                  v-if="!readOnly" type="button" class="btn btn-quiet btn-icon btn-sm rm" :aria-label="`Remove ${name(st.key)}`"
                  :aria-disabled="!removable(st.key)" :title="removable(st.key) ? 'Remove step' : 'Can’t be removed here'" @click="emit('remove', st.key)"
                ><Icon name="x" :size="14" /></button>
              </div>
              <ul v-if="issuesBy.has(st.key)" class="issues"><li v-for="(t, n) in stepIssues(st.key)" :key="n">{{ t }}</li></ul>
            </div>
          </div>

          <div v-if="s.people.length" class="blk">
            <div class="lbl-row">
              <h4 class="lbl">Assigned tasks <span class="lbl-hint">· who works here</span></h4>
              <button type="button" class="what" aria-label="What’s this? Who reaches the assigned tasks" @click="showHelp('stages')">What’s this?</button>
            </div>
            <div v-for="st in s.people" :key="st.key" class="row-wrap">
              <div class="act" :class="{ sel: st.key === selectedKey, bad: issuesBy.has(st.key) }">
                <button type="button" class="act-main" :data-step="st.key" @click="emit('select', st.key)">
                  <span class="ic p" aria-hidden="true"><Icon name="person" :size="14" /></span>
                  <b class="act-name">{{ name(st.key) }}</b>
                  <span v-if="only(st.key)" class="chip chip-warn only" :title="only(st.key) ?? undefined">{{ only(st.key) }}</span>
                  <span class="sub">{{ personLine(st).who }}<template v-if="personLine(st).asks"><br>Asks: {{ personLine(st).asks }}</template></span>
                </button>
                <button
                  v-if="!readOnly" type="button" class="btn btn-quiet btn-icon btn-sm rm" :aria-label="`Remove ${name(st.key)}`"
                  :aria-disabled="!removable(st.key)" :title="removable(st.key) ? 'Remove step' : 'Can’t be removed here'" @click="emit('remove', st.key)"
                ><Icon name="x" :size="14" /></button>
              </div>
              <ul v-if="issuesBy.has(st.key)" class="issues"><li v-for="(t, n) in stepIssues(st.key)" :key="n">{{ t }}</li></ul>
            </div>
          </div>

          <div v-if="!readOnly" class="adds">
            <template v-for="kind in (['auto', 'people'] as const)" :key="kind">
              <button type="button" class="add" :popovertarget="`add-${s.id}-${kind}`" :style="{ anchorName: `--add-${s.id}-${kind}` }">
                <Icon name="plus" :size="14" />{{ kind === 'auto' ? 'Add an action' : 'Add an assigned task' }}
              </button>
              <div :id="`add-${s.id}-${kind}`" popover class="menu add-menu" :style="{ positionAnchor: `--add-${s.id}-${kind}` }">
                <button v-for="item in paletteFor(kind)" :key="item.id" type="button" @click="($event.target as HTMLElement).closest<HTMLElement>('[popover]')?.hidePopover(); emit('add', s.id, kind, item)">
                  <Icon :name="item.icon" :size="16" />{{ item.label }}
                </button>
              </div>
            </template>
          </div>

          <div v-if="exitsOf(s).length || conditionIssues(s).length" class="blk">
            <h4 class="lbl">Advancement rules <span class="lbl-hint">· where they go next</span></h4>
            <component
              :is="x.condition ? 'button' : 'div'" v-for="(x, n) in exitsOf(s)" :key="n" :type="x.condition ? 'button' : undefined"
              class="rule" :class="{ sel: x.condition && x.condition === selectedKey, quiet: !x.rule }" :data-step="x.condition"
              @click="x.condition && emit('select', x.condition)"
            >
              <span class="when">{{ exitWhen(x) }}</span>
              <Icon name="arrow-right" :size="14" class="to" />
              <span class="chip" :class="dest(x).cls">{{ dest(x).text }}</span>
            </component>
            <ul v-if="conditionIssues(s).length" class="issues"><li v-for="(p, n) in conditionIssues(s)" :key="n">{{ p.text }}</li></ul>
          </div>

          <details class="blk ask-blk" :open="!!askOf(s.id).length">
            <summary class="lbl">Questions for manual moves <span class="lbl-hint">· asked when someone is moved here by hand</span><span v-if="askOf(s.id).length" class="n">{{ askOf(s.id).length }}</span></summary>
            <AskFields :model-value="askOf(s.id)" :stage-name="s.name" :read-only="readOnly" @update:model-value="setAsk(s.id, $event)" />
          </details>
        </section>
      </template>

      <div class="join">
        <i aria-hidden="true" />
        <button v-if="!readOnly" type="button" class="add-stage" @click="emit('addStage', view.stages.length)"><Icon name="plus" :size="14" />Add a stage</button>
      </div>

      <section class="st closed" aria-label="Closed">
        <div class="st-head"><b class="st-title">Closed</b></div>
        <div class="outcomes">
          <div v-for="c in view.closed" :key="c.outcome" class="blk">
            <b>{{ OUT[c.outcome] }}</b>
            <span class="sub">{{ closedLine(c) }}</span>
          </div>
        </div>
        <p class="sub">Closing someone by hand sends no email.</p>
      </section>
    </div>

    <aside v-if="!selectedKey" class="side" aria-label="Board and diagram">
      <div class="panel box">
        <h3>Pipeline preview</h3>
        <ol class="mini">
          <li v-for="s in view.stages" :key="s.id"><span class="mini-name">{{ s.name }}</span><b v-if="hereIn(s.id) !== undefined">{{ hereIn(s.id) }}</b></li>
          <li class="mini-closed"><span class="mini-name">Closed</span><b v-if="closedCount !== undefined">{{ closedCount }}</b></li>
        </ol>
        <p class="sub">Each stage is a column on the Pipeline board.</p>
      </div>
      <slot name="status" />
    </aside>
  </div>
</template>

<style scoped>
.stage-editor { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; min-height: 0; overflow-y: auto; padding: 24px 32px 48px; background: var(--bg); align-items: start; }
.stage-editor.narrow { grid-template-columns: minmax(0, 1fr); padding-inline: 24px; }
.list { display: flex; flex-direction: column; min-width: 0; max-width: 760px; }
.narrow .list { margin-inline: auto; width: 100%; }

.st { display: flex; flex-direction: column; gap: 12px; padding: 24px 18px 16px; transition: box-shadow var(--t-micro) var(--ease); }
.st.on { box-shadow: var(--shadow-2), 0 0 0 3px var(--accent-tint), inset 0 0 0 1px var(--accent-line); }
.st.bad { border-color: oklch(0.85 0.06 27); }
.applied { padding: 12px 18px; box-shadow: var(--shadow-1); }
.closed { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--r-card); }
.st-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.num { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 50%; background: var(--ink); color: #fff; font-size: var(--t-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
.num.ok { background: var(--ok); }
.st-title { flex: 1; font-size: var(--t-lg); }
.st-name {
  flex: 1; min-width: 0; height: 34px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--r-field);
  background: none; box-shadow: none; font-size: var(--t-lg); font-weight: 600; text-overflow: ellipsis;
}
.st-name:hover:not(:disabled) { border-color: var(--line-2); }
.st-name:focus { border-color: var(--accent); }
.meta { font-size: var(--t-sm); color: var(--ink-2); }
.meta-link { font-size: var(--t-sm); font-weight: 600; color: var(--accent-ink); }
.here { font-size: var(--t-sm); color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.st-tools { display: flex; gap: 2px; }
.btn[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
.cand { display: flex; align-items: center; gap: 10px; padding-left: 36px; font-size: var(--t-sm); color: var(--ink-2); }
.cand span { flex: none; }
.cand input { min-height: var(--h-sm); max-width: 240px; }
.cand-off { padding-left: 36px; font-size: var(--t-sm); color: var(--ink-3); }
.empty-stage { padding: 10px 12px; border-radius: var(--r-panel); background: var(--sunk); color: var(--ink-2); font-size: var(--t-sm); }

.blk { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: var(--r-panel); background: var(--sunk); }
.lbl { font-size: var(--t-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-2); }
.lbl-hint { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--ink-3); }
.lbl-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.what { padding: 0; border: 0; background: none; font: 500 var(--t-xs) var(--font); color: var(--accent-ink); text-decoration: underline; text-underline-offset: 0.18em; cursor: pointer; }
.what:hover { color: var(--ink); }
.row-wrap { display: grid; gap: 4px; }
.act { display: flex; align-items: center; gap: 2px; border-radius: var(--r-field); background: var(--surface); transition: box-shadow var(--t-micro) var(--ease); }
.act.sel { box-shadow: inset 0 0 0 1.5px var(--accent); }
.act.bad { box-shadow: inset 0 0 0 1px var(--bad); }
.act-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 10px; border: 0; border-radius: var(--r-field);
  background: none; text-align: left; font-size: var(--t-sm); color: var(--ink); cursor: pointer;
}
.act-main:hover { background: var(--hover); }
.act-name { font-weight: 600; flex-shrink: 0; max-width: 45%; overflow-wrap: break-word; }
.only { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } /* a long rule never squeezes the step name */
.sub { font-size: var(--t-xs); color: var(--ink-2); }
.act .sub { margin-left: auto; text-align: right; max-width: 55%; overflow-wrap: anywhere; }
.rm { margin-right: 4px; }
.ic { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border-radius: 7px; background: var(--machine); color: #fff; }
.ic.p { background: var(--accent); }
.issues { margin: 0; padding: 0 4px; list-style: none; font-size: var(--t-xs); font-weight: 500; color: var(--bad); }

.adds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: -4px; }
.add, .add-stage {
  display: inline-flex; align-items: center; gap: 6px; height: var(--h-sm); padding: 0 10px; border: 0; border-radius: var(--r-pill);
  background: none; font-size: var(--t-sm); font-weight: 600; color: var(--accent-ink); cursor: pointer;
}
.add:hover, .add-stage:hover { background: var(--accent-tint); }
.add-menu { inset: auto; top: anchor(bottom); left: anchor(left); margin-top: 4px; max-width: 320px; }

.rule {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 36px; padding: 4px 10px; border: 0; border-radius: var(--r-field);
  background: var(--surface); font-size: var(--t-sm); color: var(--ink); text-align: left;
}
button.rule { cursor: pointer; }
button.rule:hover { background: var(--hover); }
.rule.sel { box-shadow: inset 0 0 0 1.5px var(--accent); }
.rule.quiet .when { color: var(--ink-2); }
.when { overflow-wrap: anywhere; }
.to { color: var(--ink-3); flex: none; }

.ask-blk { background: var(--accent-tint); }
.ask-blk summary { cursor: pointer; color: var(--accent-ink); display: flex; align-items: center; gap: 6px; }
.ask-blk[open] summary { margin-bottom: 4px; }
.n { min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--r-pill); background: var(--surface); text-align: center; line-height: 18px; font-variant-numeric: tabular-nums; }

.join { display: flex; align-items: center; gap: 10px; height: 36px; padding-left: 30px; }
.join i { width: 2px; height: 100%; background: var(--line-2); }
.add-stage { color: var(--ink-2); }
.add-stage:hover { color: var(--accent-ink); }

.outcomes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.closed > .sub { margin-top: 8px; }

.side { position: sticky; top: 0; display: grid; gap: 16px; }
.box { display: grid; gap: 10px; padding: 18px; border-radius: var(--r-card); }
.box h3 { font-size: var(--t-lg); }
.mini { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px; }
.mini li { display: grid; gap: 2px; padding: 8px 6px; border-radius: 8px; background: var(--sunk); text-align: center; font-size: var(--t-xs); font-weight: 600; }
.mini-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini b { font-size: var(--t-lg); font-variant-numeric: tabular-nums; }
.mini-closed { background: none !important; box-shadow: inset 0 0 0 1px var(--line); }

@media (prefers-reduced-motion: reduce) {
  .st, .act { transition: none; }
}
@media (width < 1200px) {
  .stage-editor { grid-template-columns: minmax(0, 1fr); padding-inline: 24px; }
  .side { position: static; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
}
</style>
