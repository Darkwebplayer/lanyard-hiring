<template>
  <div class="topic-body">
    <h3>Importing candidates</h3>
    <div class="dia map" role="img" aria-label="Each column in your spreadsheet is matched to where it goes in Lanyard: name, email, or one of your questions.">
      <div v-for="(r, i) in ROWS" :key="r[0]" class="pair" :style="{ animationDelay: `${i * 0.5}s` }">
        <span class="dia-item">{{ r[0] }}</span><Icon name="arrow-right" :size="12" /><span class="dia-item to">{{ r[1] }}</span>
      </div>
    </div>
    <p>Bring in people who applied somewhere else, from a CSV file. The job must be published first, because they join its live workflow.</p>
    <ul>
      <li><b>Match the columns</b>: for each column in your file, pick where it goes. Everyone needs a name and an email. A “Full name” column is split into first and last.</li>
      <li>Send a column to <b>Note on their timeline</b> to keep anything else.</li>
      <li><b>Start everyone at</b> the start of the workflow, or use a column to pick each person’s stage.</li>
      <li>People already in the job, and rows with problems, are skipped. The check shows them before you import.</li>
    </ul>
    <p>Imported people have no CV file, so a step that reads the CV can’t work for them. Lanyard warns you and suggests a later place to start. Consent wasn’t collected, and their page says so.</p>
  </div>
</template>

<script setup lang="ts">
const ROWS = [['Name', 'Full name'], ['E-mail', 'Email'], ['Notice (weeks)', 'Notice period']]
</script>

<style scoped>
.pair { display: grid; grid-template-columns: 1fr 14px 1fr; gap: 6px; align-items: center; animation: match 6s var(--ease) infinite both; }
.dia-item { color: var(--ink); }
.to { background: var(--accent-tint); color: var(--accent-ink); }
@keyframes match { 0% { opacity: 0.3; } 12%, 90% { opacity: 1; } 100% { opacity: 0.3; } }
</style>
