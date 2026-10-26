<template>
  <div class="topic-body">
    <h3>AI screening</h3>
    <HelpAiReadsDiagram />
    <p>An <b>AI screening</b> step reads each application and scores it from 0 to 100 on each thing you list, like “Skills match” and “Experience”. The overall score is the average of those.</p>
    <h4>What it reads</h4>
    <ul>
      <li>The job’s <b>requirements</b> from Job details: must-have skills, minimum years, type and place of work.</li>
      <li>The job <b>description</b>, as background. The scores are against the requirements, so put hard rules there.</li>
      <li>The <b>CV text</b>, with the candidate’s name and contact details taken out.</li>
      <li>Their <b>form answers</b>, except protected ones and files.</li>
    </ul>
    <p>It does <b>not</b> read the candidate’s name, email or phone, or any field marked Protected.</p>

    <h4>Score bands</h4>
    <div class="bands" role="img" aria-label="Under 40 is a clear no, 40 to 69 goes to a person, 70 and up is a clear yes.">
      <span class="lo">0–39</span><span class="mid">40–69</span><span class="hi">70–100</span>
    </div>
    <p>The AI screening workflow moves 70 and up to Interview, closes under 40, and sends the middle to a person. A missing score always goes to a person. You set the numbers in the stage’s “Advancement rules”.</p>

    <h4>A person always decides</h4>
    <p>The AI only suggests. Nobody is hired without a person’s scorecard saying yes. Every score shows why on the candidate page, so you can check it.</p>
    <p>If an admin turns AI off in Settings, AI steps wait until it’s back on and someone retries them.</p>
  </div>
</template>

<style scoped>
.bands { display: grid; grid-template-columns: 40fr 30fr 30fr; border-radius: var(--r-field); overflow: hidden; font-size: var(--t-xs); font-weight: 600; text-align: center; }
.bands span { padding: 8px 4px; }
.lo { background: var(--sunk); color: var(--ink-2); } .mid { background: var(--accent); color: #fff; } .hi { background: var(--ink); color: #fff; }
</style>
