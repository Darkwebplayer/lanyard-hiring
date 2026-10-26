<template>
  <div class="topic-body">
    <h3>Jobs</h3>
    <div class="dia job" role="img" aria-label="A job holds its details, its apply form and its workflow. Publish puts it live at its apply link.">
      <div class="parts"><span class="dia-item">Job details</span><span class="dia-item">Application form</span><span class="dia-item">Workflow</span></div>
      <span class="pub">Publish</span>
      <span class="link"><Icon name="link" :size="12" />Apply link is live</span>
    </div>
    <p>A job holds the role, its apply form and the <b>workflow</b> each candidate goes through. Nothing reaches candidates until you <b>Publish</b>.</p>
    <h4>Starting a job</h4>
    <p><b>New job</b> walks you through five steps. Anything past the role can wait and be filled in later.</p>
    <ol>
      <li><b>The role</b>: the job title and how many <b>Openings</b>. Hiring two of the same role? Make one job with 2 openings.</li>
      <li><b>How you hire</b>: the workflow. Under <b>New workflow</b>, <b>Describe it in your own words</b> and AI drafts the stages for you to check, pick a ready-made one (<b>AI screening</b> scores CVs so you only look at the strong and borderline ones; <b>Simple</b> has you review everyone, no AI), or <b>Start blank</b>. Under <b>Use existing</b>, start from one of <b>your workflow templates</b>, or <b>Copy another job</b> (its form and workflow, not its candidates).</li>
      <li><b>About the job</b>: description, location, salary range (shown on the apply page only if you tick it) and a closing date. Leave the date empty to keep it open.</li>
      <li><b>Must-haves</b>: skills and minimum years of experience. AI screening scores each CV against these.</li>
      <li><b>Check</b>: what you’re making and what happens to an applicant. Create it, then check the form and Publish.</li>
    </ol>
    <p>After that, change anything in the job’s tabs: <b>Pipeline</b>, <b>Workflow</b>, <b>Application form</b> and <b>Job details</b>.</p>
    <h4>What the labels mean</h4>
    <ul>
      <li><b>Draft</b>: not published yet. <b>Live</b>: taking applications. <b>Closed</b>: not taking any. <b>Archived</b>: kept for the record, can’t change.</li>
      <li><b>Unpublished changes</b>: you edited a live job. Publish to use the changes.</li>
    </ul>
    <p>Share the apply link anywhere. Give each place its own tag, and Reports shows where your hires came from.</p>
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
