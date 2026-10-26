<script setup lang="ts">
const { isManager } = useMe()
</script>

<template>
  <div class="topic-body">
    <h3>Updates</h3>
    <p>The bell beside Ask tells you what changed while you were away. Open it and the number goes back to zero. Choose a line to go to that candidate, at the step or the offer it is about.</p>
    <div class="dia" role="img" aria-label="Three lines: red for a stopped step, magenta for an offer accepted, grey for a scorecard sent.">
      <span class="ln"><i class="bad" />AI screen couldn’t run for Maya Okafor</span>
      <span class="ln"><i class="acc" />Priya accepted the offer for Pastry chef</span>
      <span class="ln faint"><i />Joon finished Interview for Ama Mensah</span>
    </div>
    <ul>
      <li><b>Red</b>: a step stopped. Retry it or move the candidate on.</li>
      <li v-if="isManager"><b>Magenta</b>: worth knowing now. An interviewer passed and the step needs more people, an offer was answered, someone was hired. Red and magenta lines add to the number.</li>
      <li v-else><b>Magenta</b>: a new task for you, or a time booked or called off. These add to the number.</li>
      <li><b>Grey</b>: listed, never counted. Scorecards sent, interviews booked, new applications.</li>
      <li>You never get your own moves, or what a move did by itself (the interview it called off).</li>
      <li>× hides one line. Clear all hides them all. The candidate page keeps the full record.</li>
    </ul>
    <p class="faint">The Inbox number is different: it counts only tasks that wait on you.</p>
  </div>
</template>

<style scoped>
.dia { display: grid; gap: 6px; }
.ln { display: flex; align-items: center; gap: 10px; }
.ln i { width: 4px; height: 18px; border-radius: 3px; background: var(--line-2); flex: none; }
.ln .bad { background: var(--bad); }
.ln .acc { background: var(--accent); }
</style>
