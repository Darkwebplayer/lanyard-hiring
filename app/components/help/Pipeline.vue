<template>
  <div class="topic-body">
    <h3>The pipeline</h3>
    <HelpFlowDiagram :stages="[{ name: 'Screening', ai: true }, { name: 'Interview' }, { name: 'Decision' }]" />
    <p>Everyone who applied, one column per stage. Switch to <b>List</b> to search, filter and move many at once.</p>

    <h4>Moving someone</h4>
    <div class="dia drag" role="img" aria-label="A card is dragged to the next column. That column says Next, and shows what the move sets off before you drop.">
      <div class="cols"><span class="col">Screening<span class="card-mini">Mei Tan</span></span><span class="col to">Interview<span class="tag">Next</span></span></div>
    </div>
    <ul>
      <li>Drag a card. While you drag, each place says what dropping there means: <b>Next</b>, <b>Skips 2 steps</b>, <b>Goes back</b> or <b>Close as rejected</b>.</li>
      <li>Hover over a place to see what the move sets off, like an email or a new task, before you let go.</li>
      <li>You confirm in a box. Skipping or going back asks why. Rejecting asks a reason from your list.</li>
    </ul>
    <p>Moves follow the <b>published</b> workflow, the one candidates are on. Click a card to open the candidate.</p>
    <p>Have people from a spreadsheet? Use <b>Import candidates</b>.</p>
  </div>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.col { position: relative; display: grid; gap: 6px; align-content: start; min-height: 72px; padding: 8px; border-radius: var(--r-field); background: var(--surface); color: var(--ink); }
.card-mini { justify-self: start; padding: 5px 9px; border-radius: 8px; background: var(--surface); box-shadow: var(--shadow-2), 0 0 0 1px var(--line); font-weight: 600; animation: carry 5s var(--ease) infinite; }
@keyframes carry { 0%, 15% { translate: 0 0; } 55%, 80% { translate: calc(100% + 60px) 0; opacity: 1; } 90% { opacity: 0; translate: calc(100% + 60px) 0; } 100% { opacity: 0; } }
.tag { justify-self: start; padding: 2px 8px; border-radius: var(--r-pill); background: var(--accent-tint); color: var(--accent-ink); animation: hint 5s var(--ease) infinite; }
@keyframes hint { 0%, 20% { opacity: 0; } 30%, 85% { opacity: 1; } 100% { opacity: 0; } }
.to { animation: ring 5s var(--ease) infinite; }
@keyframes ring { 0%, 40% { box-shadow: none; } 50%, 80% { box-shadow: inset 0 0 0 1.5px var(--accent); } 100% { box-shadow: none; } }
</style>
