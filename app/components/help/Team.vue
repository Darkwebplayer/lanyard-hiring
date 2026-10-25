<template>
  <div class="topic-body">
    <h3>Your team</h3>
    <div class="dia roles" role="img" aria-label="Admins see everything. Managers run jobs. Employees see only their own tasks.">
      <div v-for="r in ROLES" :key="r.name" class="role">
        <span class="badge" aria-hidden="true" /><b>{{ r.name }}</b>
        <ul><li v-for="x in r.sees" :key="x">{{ x }}</li></ul>
      </div>
    </div>
    <p>Everyone who helps you hire. Each person has a <b>role</b>, and each role has a <b>level</b> that decides what they see.</p>
    <ul>
      <li><b>Manager</b>: jobs, flows and all candidates.</li>
      <li><b>Employee</b>: only their own tasks and their interview hours. An interviewer sees just the people they’re asked to score.</li>
      <li><b>Admin</b>: everything, plus Team and Settings. The admin is set on the server, not here.</li>
    </ul>
    <h4>Inviting people</h4>
    <p>Add their email and a role. They sign in with Google using that address and join the list at once. To change an invite’s role, invite the same address again.</p>
    <h4>Roles</h4>
    <p>Name roles the way you talk, like “Shift lead”. A person step can go to a role, so anyone with it can pick up the task. Switching someone off signs them out at once. Their history stays, but tasks waiting on them stay too, so reassign those.</p>
  </div>
</template>

<script setup lang="ts">
const ROLES = [
  { name: 'Admin', sees: ['Everything', 'Team', 'Settings'] },
  { name: 'Manager', sees: ['Jobs', 'Candidates', 'Hires'] },
  { name: 'Employee', sees: ['Their tasks', 'Their hours'] },
]
</script>

<style scoped>
.roles { grid-template-columns: repeat(3, 1fr); }
.role { display: grid; gap: 6px; justify-items: center; padding: 10px 4px; border-radius: var(--r-field); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); animation: lit 9s var(--ease) infinite; }
.role:nth-child(2) { animation-delay: 3s; }
.role:nth-child(3) { animation-delay: 6s; }
@keyframes lit { 0%, 30% { box-shadow: inset 0 0 0 1.5px var(--accent); } 33%, 100% { box-shadow: inset 0 0 0 1px var(--line); } }
.badge { position: relative; width: 24px; height: 30px; border-radius: 6px; background: var(--ink); }
.badge::before { content: ""; position: absolute; top: 4px; left: 50%; translate: -50% 0; width: 10px; height: 3px; border-radius: 2px; background: var(--accent); }
.role ul { list-style: none; padding: 0; gap: 1px; font-weight: 500; text-align: center; }
</style>
