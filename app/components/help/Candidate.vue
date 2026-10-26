<template>
  <div class="topic-body">
    <h3>A candidate</h3>
    <div class="dia why" role="img" aria-label="The Score rationale card: Screen sent this candidate to Interview because their score was 78, which is 70 or more.">
      <span class="eyebrow">Score rationale</span>
      <p class="line">Screen sent this to Interview: <span class="hl">score 78 is 70 or more</span>.</p>
    </div>
    <p>Everything about one person in one job.</p>
    <ul>
      <li>The <b>Score rationale</b> card says in plain words why they’re where they are: the rule that sent them, or who moved them and their reason.</li>
      <li><b>Scores</b> show each AI score as a bar, with the AI’s summary.</li>
      <li><b>Hiring progress</b> is their path so far: scorecards, emails, and who each task is with. Add or remove people there.</li>
      <li><b>Application answers</b> has their answers and what they agreed to when they applied.</li>
    </ul>
    <h4>Moving them on</h4>
    <ul>
      <li><b>Next in the workflow</b> follows the usual path. <b>Other moves</b> can skip steps, which asks for a reason.</li>
      <li><b>Close as rejected</b> asks a reason from your list and sends no email.</li>
      <li><b>Make offer</b> sends a letter from your Templates. When they accept on the link, they’re hired.</li>
    </ul>
  </div>
</template>

<style scoped>
.why { background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); padding-top: 22px; }
.why::before { content: ""; position: absolute; top: 8px; left: 50%; translate: -50% 0; width: 24px; height: 4px; border-radius: 9px; background: var(--machine); }
.line { font-size: var(--t-md); font-weight: 500; color: var(--ink); }
.hl { background: linear-gradient(var(--accent-tint), var(--accent-tint)) 0 0 / 100% 100% no-repeat; border-radius: 4px; animation: mark 5s var(--ease) infinite; }
@keyframes mark { 0%, 20% { background-size: 0 100%; } 45%, 90% { background-size: 100% 100%; } 100% { background-size: 0 100%; } }
</style>
