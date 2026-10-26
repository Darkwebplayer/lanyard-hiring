<template>
  <div class="topic-body">
    <h3>Application form</h3>
    <div class="dia" role="img" aria-label="The questions you add appear on the apply page. A protected question is hidden from the AI and from interviewers.">
      <div class="dia-item">Name, email, phone<span class="faint">Standard fields</span></div>
      <div class="dia-item q">CV<span class="chip">File</span></div>
      <div class="dia-item q">Notice period<span class="chip">Number</span></div>
      <div class="dia-item q prot">Date of birth<span class="chip"><Icon name="eye-off" />Protected</span></div>
    </div>
    <p>What candidates fill in when they apply. Name and contact details are <b>standard fields</b>. Everything else is <b>custom questions</b>: a CV, a yes or no, a number, a choice.</p>
    <ul>
      <li>The preview beside the list shows what candidates see.</li>
      <li>Mark a question <b>Protected</b> to hide it from the AI and from interviewers, such as date of birth.</li>
      <li>A Decision later in the workflow can use any answer, like “Notice period is at most 4 weeks”.</li>
      <li>A question already in a published version is <b>locked</b> to its type. To ask it differently, add a new question.</li>
    </ul>
    <p>Changes reach the apply page when you <b>Publish</b>.</p>
  </div>
</template>

<style scoped>
.dia-item { color: var(--ink); }
.q { animation: add 6s var(--ease) infinite both; }
.q:nth-child(3) { animation-delay: 0.5s; }
.q:nth-child(4) { animation-delay: 1s; }
@keyframes add { 0% { opacity: 0; translate: 0 6px; } 10%, 90% { opacity: 1; translate: 0 0; } 100% { opacity: 0; } }
.prot { background: var(--sunk); box-shadow: inset 0 0 0 1px var(--line-2); }
</style>
