<template>
  <div class="topic-body">
    <h3>Settings</h3>
    <div class="dia rr" role="img" aria-label="When someone is rejected, the person picks a reason from your list. Past decisions keep the words they were made with.">
      <div class="dia-item">Hired someone else</div>
      <div class="dia-item pick">Not enough experience<Icon name="check" :size="12" /></div>
      <div class="dia-item">Didn’t reply</div>
    </div>
    <p>Things that apply to every job. Only admins see this page.</p>
    <ul>
      <li><b>Company name</b> shows above every job, so candidates know who they’re applying to.</li>
      <li><b>Reply-to email</b>: where candidates’ replies go, for every email your flows send.</li>
      <li><b>Consent text</b> adds a box candidates must tick before they send. Leave it empty for no box.</li>
      <li><b>Use AI</b> turns on AI reviews, Ask and describe-your-flow. The <b>AI screening notice</b> tells candidates an automated review reads their application.</li>
      <li><b>Careers page</b>: a line about you, and a job feed link for boards like Indeed.</li>
    </ul>
    <h4>Reject reasons</h4>
    <p>Whoever rejects someone picks one of these, so you can see later why people were turned down. Keep between 1 and 20. Renaming or removing one never changes past decisions.</p>
    <p>Press <b>Save settings</b> when you’re done. Nothing saves by itself here.</p>
  </div>
</template>

<style scoped>
.dia-item { color: var(--ink); font-weight: 500; }
.pick { animation: pick 5s var(--ease) infinite; }
.pick svg { color: var(--accent-ink); animation: tick 5s var(--ease) infinite; }
@keyframes pick { 0%, 35% { box-shadow: none; } 45%, 90% { box-shadow: inset 0 0 0 1.5px var(--accent); } 100% { box-shadow: none; } }
@keyframes tick { 0%, 40% { opacity: 0; } 50%, 90% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pick { box-shadow: inset 0 0 0 1.5px var(--accent); } }
</style>
