<template>
  <div class="topic-body">
    <h3>Glossary</h3>
    <div class="dia nest" role="img" aria-label="A workflow holds stages. A stage holds steps. A step a person does is a task.">
      <span class="lvl f">Workflow<span class="lvl s">Stage<span class="lvl t">Step</span><span class="lvl t p">Task</span></span></span>
    </div>
    <dl class="gl">
      <dt>Stage</dt><dd>A column on your board, like Screening. It holds steps.</dd>
      <dt>Step</dt><dd>One thing inside a stage: CV extraction, AI screening, send email, an assigned task.</dd>
      <dt>Assigned task</dt><dd>A step a person does, like a scorecard. It shows in their Inbox until they send it.</dd>
      <dt>Workflow</dt><dd>All the stages of a job, in order. Save one as a template to reuse it.</dd>
      <dt>Decision</dt><dd>A step that picks the path, using rules like “score is 70 or more”. In the AI screening workflow it’s called Screen. A stage can also be named Decision: that one just holds the last emails.</dd>
      <dt>Rule</dt><dd>One line of a Decision: something to check, a test and a value.</dd>
      <dt>Publish</dt><dd>Puts your changes live for new applicants. People already in keep the version they started on.</dd>
      <dt>Version</dt><dd>Each Publish makes a new one, so you can see which workflow someone is on.</dd>
      <dt>Job owner</dt><dd>The person set on the job’s Job details tab. Steps “for the job owner” go to them.</dd>
    </dl>

    <h4 id="fields">What a rule can check</h4>
    <p>The list is grouped by where the answer comes from: <b>Candidate</b>, the <b>Application form</b>, the <b>Job</b>, and each step before this one, by its name.</p>
    <ul>
      <li>Most rules use a <b>score</b> from AI screening, a <b>form answer</b>, or a <b>scorecard answer</b> from an assigned task.</li>
      <li>Things like CV text, AI summary and file checksum are there for completeness. You rarely need them.</li>
    </ul>
  </div>
</template>

<style scoped>
.nest { place-items: center; }
.lvl { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-radius: var(--r-field); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--ink); }
.s { background: var(--sunk); }
.t { padding: 4px 9px; border-radius: var(--r-pill); background: var(--machine); color: #fff; box-shadow: none; }
.t.p { background: var(--accent); }
.f { animation: in 4.5s var(--ease) infinite; }
.s { animation: in 4.5s var(--ease) 0.6s infinite both; }
.t { animation: in 4.5s var(--ease) 1.2s infinite both; }
.t.p { animation-delay: 1.8s; }
@keyframes in { 0% { opacity: 0; scale: 0.94; } 12%, 88% { opacity: 1; scale: 1; } 100% { opacity: 0; } }
</style>
