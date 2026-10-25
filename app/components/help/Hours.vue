<template>
  <div class="topic-body">
    <h3>Your interview hours</h3>
    <div class="dia" role="img" aria-label="The candidate gets a link and picks one free slot inside your hours.">
      <b class="cap">What the candidate sees</b>
      <div class="week" aria-hidden="true">
        <em /><b>M</b><b>T</b><b>W</b><b>T</b><b>F</b>
        <template v-for="h in ['9', '10', '11', '2', '3']" :key="h">
          <em>{{ h }}</em><span v-for="d in 5" :key="d" :class="{ pick: h === '10' && d === 3 }" />
        </template>
      </div>
      <span class="faint">Booked: Wed 10:00. It shows in your inbox.</span>
    </div>
    <p>When a person step lets the candidate book, they get a link and pick a free time <b>inside these hours</b>. Without hours, nobody can book you.</p>
    <ul>
      <li>Turn on the days you interview. Add more than one range on a day for a lunch break.</li>
      <li>Pick your time zone. Candidates see times in their own.</li>
      <li>On a panel, they only see times when everyone on it is free.</li>
      <li>Saving changes the times offered from now on. Booked interviews stay as they are.</li>
    </ul>
  </div>
</template>

<style scoped>
.cap { color: var(--ink); }
.week { display: grid; grid-template-columns: 22px repeat(5, 1fr); gap: 3px; color: var(--ink-3); font-weight: 500; }
.week span { height: 14px; border-radius: 3px; background: var(--accent-tint); }
.week em { font-style: normal; text-align: right; padding-right: 4px; }
.week b { text-align: center; }
.week .pick { animation: book 5s var(--ease) infinite; }
@keyframes book { 0%, 40% { background: var(--accent-tint); } 50%, 90% { background: var(--accent); } 100% { background: var(--accent-tint); } }
@media (prefers-reduced-motion: reduce) { .week .pick { background: var(--accent); } }
</style>
