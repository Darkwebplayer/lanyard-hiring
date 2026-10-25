<script lang="ts">
import { OUTCOMES } from '~~/shared/workflow/registry'
import { type Pos, arrivalEffects, relation, resting } from '~~/shared/workflow/stages'
import type { Graph } from '~~/shared/workflow/types'
import { type Timeline, stepName } from './Trace.vue'

export type { Pos }
export interface NextMove { to: Pos, branch: string | null, name: string, does: string | null }

export const posName = (tl: Timeline, p: Pos) => 'node' in p ? stepName(tl, p.node) : OUTCOME[p.closed]?.text ?? p.closed

// Where the flow itself goes from here: every place one step on, with the branch that leads there.
export function nextMoves(tl: Timeline, graph: Graph, at: string): NextMove[] {
  const places: Pos[] = [...graph.nodes.filter(n => resting(n.type)).map(n => ({ node: n.key })), ...OUTCOMES.map(o => ({ closed: o }))]
  return places.flatMap((to) => {
    const r = relation(graph, { node: at }, to)
    if (r.kind !== 'next') return []
    return [{ to, branch: r.branch ?? null, name: posName(tl, to), does: arrivalEffects(graph, to)[0]?.text ?? null }]
  })
}
</script>

<script setup lang="ts">
// "At ‹step› ▾": the moves the flow offers from here, by name, then the hand moves, then the flow itself.
const props = defineProps<{ tl: Timeline, graph: Graph, at: string }>()
const emit = defineEmits<{ pick: [to: Pos | null], flow: [] }>()
const menu = ref<HTMLElement>()
const moves = computed(() => nextMoves(props.tl, props.graph, props.at))
function choose(to: Pos | null) {
  menu.value?.hidePopover()
  emit('pick', to)
}
function flow() {
  menu.value?.hidePopover()
  emit('flow')
}
</script>

<template>
  <button type="button" class="btn at-btn" popovertarget="next-moves">
    At {{ stepName(tl, at) }}<Icon name="chevron-down" :size="14" />
  </button>
  <div id="next-moves" ref="menu" popover class="menu next-menu">
    <template v-if="moves.length">
      <p class="mh">Next in the flow</p>
      <button v-for="m in moves" :key="'node' in m.to ? m.to.node : m.to.closed" type="button" @click="choose(m.to)">
        <span class="dot" :class="{ end: 'closed' in m.to }" aria-hidden="true"><Icon name="arrow-right" :size="12" /></span>
        <span class="txt">
          <span><b v-if="m.branch">{{ m.branch }}</b><template v-if="m.branch"> → </template><span :class="{ strong: !m.branch }">{{ m.name }}</span></span>
          <small v-if="m.does">{{ m.does }}</small>
        </span>
      </button>
      <hr>
    </template>
    <p class="mh">Other moves</p>
    <button type="button" @click="choose(null)">
      <span class="dot blank" aria-hidden="true" />
      <span class="txt"><span>Move to another step…</span><small>Skipping steps asks for a reason</small></span>
    </button>
    <button type="button" @click="choose({ closed: 'rejected' })">
      <span class="dot blank" aria-hidden="true" />
      <span class="txt"><span>Close as rejected…</span><small>Asks a reason from your list. Emailing them is up to you</small></span>
    </button>
    <button type="button" @click="choose({ closed: 'withdrawn' })">
      <span class="dot blank" aria-hidden="true" />
      <span class="txt"><span>Close as withdrawn</span></span>
    </button>
    <hr>
    <button type="button" class="view" @click="flow"><Icon name="branch" :size="16" />View flow</button>
  </div>
</template>

<style scoped>
.at-btn { anchor-name: --next-moves; max-width: 100%; }
.next-menu { position-anchor: --next-moves; inset: auto; top: anchor(bottom); right: anchor(right); margin-top: 8px; width: min(360px, calc(100vw - 32px)); }
.mh { padding: 8px 10px 4px; font-size: var(--t-xs); font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; }
.next-menu button { min-height: 44px; align-items: flex-start; }
.txt { display: grid; gap: 1px; min-width: 0; overflow-wrap: anywhere; }
.txt b, .strong { font-weight: 600; }
.txt small { font-size: var(--t-xs); color: var(--ink-2); font-weight: 400; }
.dot { flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: #fff; }
.dot.end { background: var(--ink); }
.dot.blank { background: none; }
.next-menu .view { color: var(--accent-ink); font-weight: 600; align-items: center; }
</style>
