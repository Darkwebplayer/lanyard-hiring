<script setup lang="ts">
// What happens to an applicant: one person goes through every stage, another is closed at the first.
// The runners hop through at most six columns (one keyframe set for any count); the resting frame,
// which reduced motion shows, has the first at the end and the second closed.
const props = defineProps<{ stages: { name: string, ai?: boolean }[] }>()
// ponytail: long flows show their first four stages and the last one; the label still names them all
const shown = computed(() => props.stages.length > 5 ? [...props.stages.slice(0, 4), props.stages.at(-1)!] : props.stages)
const cols = computed(() => [{ name: 'Applied' }, ...shown.value])
const label = computed(() => props.stages.length
  ? `An applicant moves from Applied through ${props.stages.map(s => s.name).join(', ')}. Some are closed early with an email.`
  : 'An applicant arrives at Applied.')
</script>

<template>
  <div class="flow" role="img" :aria-label="label" :style="{ '--n': cols.length }">
    <div class="lane" aria-hidden="true">
      <div v-for="(c, i) in cols" :key="i" class="col" :style="{ '--i': i }">
        <span>{{ c.name }}</span><b v-if="'ai' in c && c.ai" class="ai">AI</b>
      </div>
      <span class="runner" />
      <span v-if="cols.length > 1" class="runner b" />
    </div>
    <div class="closed" aria-hidden="true"><span>Not a fit: closed, with an email</span><span>Hired</span></div>
  </div>
</template>

<style scoped>
.flow {
  --cycle: calc(var(--t-move) * 30); --slot: calc(var(--cycle) / 6);
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); padding: 18px 14px 12px;
  display: grid; gap: 62px;
}
.lane { position: relative; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 4px; }
.col {
  display: grid; justify-items: center; gap: 2px; padding: 8px 2px; border-radius: var(--r-field); background: var(--sunk);
  color: var(--ink-2); font-size: 11px; font-weight: 600; letter-spacing: -0.01em; text-align: center; overflow-wrap: break-word; hyphens: auto; /* five columns: "Inter-view", not "Intervie w" */
  animation: lit var(--cycle) var(--ease) infinite; animation-delay: calc(var(--i) * var(--slot));
}
.ai { padding: 0 5px; border-radius: var(--r-pill); background: var(--machine); color: #fff; font-size: 10px; line-height: 15px; }
@keyframes lit { 0%, 14% { background: var(--ink); color: #fff; } 16.7%, 100% { background: var(--sunk); color: var(--ink-2); } }
/* --k-th hop's column centre, held at the last column once the stages run out */
.runner {
  --c0: calc(0.5 * 100% / var(--n)); --c1: calc((min(1, var(--n) - 1) + 0.5) * 100% / var(--n));
  --c2: calc((min(2, var(--n) - 1) + 0.5) * 100% / var(--n)); --c3: calc((min(3, var(--n) - 1) + 0.5) * 100% / var(--n));
  --c4: calc((min(4, var(--n) - 1) + 0.5) * 100% / var(--n)); --c5: calc((var(--n) - 0.5) * 100% / var(--n));
  position: absolute; top: calc(100% + 10px); left: var(--c5); width: 20px; height: 20px; translate: -50% 0;
  border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--surface);
  animation: run var(--cycle) var(--ease) infinite;
}
@keyframes run {
  0% { left: var(--c0); opacity: 0; } 3%, 12% { left: var(--c0); opacity: 1; }
  16.7%, 28% { left: var(--c1); } 33.3%, 45% { left: var(--c2); } 50%, 62% { left: var(--c3); }
  66.7%, 78% { left: var(--c4); } 83.3%, 96% { left: var(--c5); opacity: 1; } 100% { left: var(--c5); opacity: 0; }
}
.runner.b { left: var(--c1); top: calc(100% + 34px); background: var(--ink-3); z-index: 1; animation-name: run-b; }
@keyframes run-b {
  0% { left: var(--c0); top: calc(100% + 10px); opacity: 0; } 3%, 12% { left: var(--c0); top: calc(100% + 10px); opacity: 1; }
  16.7% { left: var(--c1); top: calc(100% + 10px); } 25%, 90% { left: var(--c1); top: calc(100% + 34px); opacity: 1; }
  100% { left: var(--c1); top: calc(100% + 34px); opacity: 0; }
}
.closed { display: flex; justify-content: space-between; gap: 12px; font-size: var(--t-xs); color: var(--ink-3); }
</style>
