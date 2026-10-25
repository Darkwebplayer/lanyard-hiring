<template>
  <div class="topic-body">
    <h3>The library</h3>
    <div class="dia copy" role="img" aria-label="A preset is copied into each flow that uses it. Changing the preset later doesn't change those flows.">
      <div class="dia-item src">Phone screen<span class="chip chip-accent">Preset</span></div>
      <div class="flows"><span class="dia-item c1">Barista flow</span><span class="dia-item c2">Driver flow</span></div>
    </div>
    <p>Things you set up once and reuse in many jobs.</p>
    <ul>
      <li><b>Steps</b>: presets for the steps you add to stages, like a phone screen with its scorecard. The ones marked <b>In palette</b> show in every flow’s palette.</li>
      <li><b>Flow presets</b>: whole flows with their form. Start a new job from one, or save a job’s flow as a preset. Built-in ones can’t change: duplicate one to make your own.</li>
      <li><b>Offer letters</b>: the letters you send with an offer, with details filled in when you make it.</li>
    </ul>
    <p>Everything is <b>copied</b> where it’s used. Changing a preset or a letter never changes flows, jobs or offers that already use it.</p>
  </div>
</template>

<style scoped>
.dia-item { color: var(--ink); }
.flows { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.c1, .c2 { animation: copy 5s var(--ease) infinite both; }
.c2 { animation-delay: 0.6s; }
@keyframes copy { 0% { opacity: 0; translate: 0 -10px; } 15%, 90% { opacity: 1; translate: 0 0; } 100% { opacity: 0; } }
</style>
