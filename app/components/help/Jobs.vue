<template>
  <div class="topic-body">
    <h3>Jobs</h3>
    <div class="dia job" role="img" aria-label="A job holds its details, its apply form and its flow. Publish puts it live at its apply link.">
      <div class="parts"><span class="dia-item">Details</span><span class="dia-item">Form</span><span class="dia-item">Flow</span></div>
      <span class="pub">Publish</span>
      <span class="link"><Icon name="link" :size="12" />Apply link is live</span>
    </div>
    <p>A job holds the role, its apply form and the <b>flow</b> each candidate goes through. Nothing reaches candidates until you <b>Publish</b>.</p>
    <h4>Starting a job</h4>
    <ul>
      <li><b>AI screening</b>: the AI scores CVs, and you only look at the strong and borderline ones.</li>
      <li><b>Simple</b>: you review everyone yourself. No AI.</li>
      <li>Or start from one of <b>your saved flows</b>, a blank flow, or a copy of another job (its form and flow, not its candidates).</li>
    </ul>
    <p>You can change any stage later.</p>
    <h4>What the labels mean</h4>
    <ul>
      <li><b>Draft</b>: not published yet. <b>Live</b>: taking applications. <b>Closed</b>: not taking any. <b>Archived</b>: kept for the record, can’t change.</li>
      <li><b>Unpublished changes</b>: you edited a live job. Publish to use the changes.</li>
    </ul>
    <p>Share the apply link anywhere. Give each place its own tag, and the Hires report shows where your hires came from.</p>
  </div>
</template>

<style scoped>
.job { justify-items: center; }
.parts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; width: 100%; }
.parts .dia-item { justify-content: center; color: var(--ink); animation: gather 5s var(--ease) infinite; }
@keyframes gather { 0%, 30% { translate: 0 0; } 45%, 100% { translate: 0 4px; } }
.pub { padding: 5px 14px; border-radius: var(--r-pill); background: var(--accent); color: #fff; animation: press 5s var(--ease) infinite; }
@keyframes press { 0%, 40% { scale: 1; } 46% { scale: 0.94; } 52%, 100% { scale: 1; } }
.link { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: var(--r-pill); background: var(--ok-tint); color: var(--ok); animation: live 5s var(--ease) infinite; }
@keyframes live { 0%, 50% { opacity: 0.2; } 58%, 95% { opacity: 1; } 100% { opacity: 0.2; } }
</style>
