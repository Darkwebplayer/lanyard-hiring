<template>
  <!-- What the AI review is given: the CV and the two structured requirements, never the description -->
  <div class="reads" role="img" aria-label="The AI reads the CV, the must-have skills and the minimum years. It does not read the description.">
    <div class="ins" aria-hidden="true">
      <span class="in">CV</span><span class="in">Must-have skills</span><span class="in">Minimum years</span><span class="in no">Description</span>
    </div>
    <span class="arrow" aria-hidden="true" />
    <div class="engine" aria-hidden="true">AI review<b>78</b><span>score</span></div>
  </div>
</template>

<style scoped>
.reads {
  display: grid; grid-template-columns: minmax(0, 1fr) 24px 92px; gap: 8px; align-items: center; padding: 16px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel);
}
.ins { display: grid; gap: 6px; }
.in {
  position: relative; overflow: hidden; padding: 6px 10px; border-radius: 8px; background: var(--accent-tint); color: var(--accent-ink);
  font-size: var(--t-xs); font-weight: 600;
}
/* a light passes along each input in turn, as if read */
.in::after {
  content: ""; position: absolute; inset: 0; translate: -100% 0;
  background: linear-gradient(90deg, transparent, oklch(1 0 0 / 0.7), transparent);
  animation: sweep calc(var(--t-move) * 14) var(--ease) infinite;
}
.in:nth-child(2)::after { animation-delay: 0.3s; }
.in:nth-child(3)::after { animation-delay: 0.6s; }
@keyframes sweep { 0% { translate: -100% 0; } 40%, 100% { translate: 100% 0; } }
.in.no { background: var(--sunk); color: var(--ink-3); text-decoration: line-through; }
.in.no::after { display: none; }
.arrow { position: relative; height: 2px; background: var(--line-2); }
.arrow::after { content: ""; position: absolute; right: -1px; top: -4px; border: 5px solid transparent; border-left-color: var(--line-2); }
.engine {
  display: grid; justify-items: center; gap: 4px; padding: 10px 6px; border-radius: 12px; background: var(--machine); color: #fff;
  font-size: var(--t-xs); font-weight: 600;
}
.engine b { font: 600 22px/1 var(--mono); animation: breathe calc(var(--t-move) * 14) var(--ease) infinite; }
.engine span { font-weight: 400; opacity: 0.8; }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
</style>
