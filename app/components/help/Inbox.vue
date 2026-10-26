<script setup lang="ts">
const { isManager } = useMe()
</script>

<template>
  <div class="topic-body">
    <h3>Inbox</h3>
    <div class="dia list" role="img" aria-label="A list of three tasks. Pressing j moves to the next one. Sending a scorecard opens the next task.">
      <div class="dia-item r1">Interview Ben Okafor<span class="chip">Due today</span></div>
      <div class="dia-item r2">Review Mei Tan<span class="chip">2 days</span></div>
      <div class="dia-item r3">Interview Raj Patel<span class="chip">3 days</span></div>
      <p class="keys"><span class="kbd">j</span> next · <span class="kbd">k</span> back</p>
    </div>
    <p>Each row is a <b>task</b>: a step in a workflow that waits for you, like a review or an interview scorecard. It stays here until you send it.</p>
    <ul>
      <li>Press <span class="kbd">j</span> and <span class="kbd">k</span> to go down and up the list. The arrow keys work too once the list has focus.</li>
      <li>When you send a scorecard, your next task opens by itself, and the top of the page says what you sent.</li>
      <li>On a panel, where several people score the same candidate, you can’t see the others’ answers until you send yours.</li>
    </ul>
    <h4>Up for grabs</h4>
    <p>A task sent to a whole role, or to more people than it needs, waits under <b>Up for grabs</b>. The first person to press <b>Take it</b> gets it, and it leaves everyone else’s list, so two people never work the same candidate. <b>Not for me</b> hides it from you only. Your next 7 days show beside the button, so you can see if you have room. For an interview, the candidate gets the booking link once someone takes it.</p>
    <h4>Schedule and Done</h4>
    <p><b>Schedule</b> lists the interviews booked with you, day by day, with a calendar of the week. <b>Done</b> keeps every task you sent, with your answers, so you can look back.</p>
    <template v-if="isManager">
      <h4>Needs attention</h4>
      <p>Things in your jobs that need a hand:</p>
      <ul>
        <li><b>Failed</b>: an automatic step failed, such as a CV that can’t be read. Retry it, or move the candidate on.</li>
        <li><b>Blocked</b>: too few people are left to finish a step. Reassign it on the candidate page.</li>
        <li><b>Overdue</b>: a task is past its due date.</li>
        <li><b>Stalled</b>: someone hasn’t moved for a while. Retry starts their step again.</li>
      </ul>
      <p>In Schedule, <b>Everyone</b> shows the whole team’s week, so you can see who is busy before you assign someone.</p>
    </template>
    <p>Interviews are booked inside <NuxtLink to="/inbox/hours" class="go">your interview availability</NuxtLink>. Set them once.</p>
  </div>
</template>

<style scoped>
.dia-item { color: var(--ink); animation: on 6s var(--ease) infinite; }
.r2 { animation-delay: 2s; } .r3 { animation-delay: 4s; }
@keyframes on { 0%, 30% { box-shadow: inset 0 0 0 1.5px var(--accent); } 34%, 100% { box-shadow: none; } }
.keys { margin-top: 2px; font-weight: 500; }
@media (prefers-reduced-motion: reduce) { .r1 { box-shadow: inset 0 0 0 1.5px var(--accent); } }
</style>
