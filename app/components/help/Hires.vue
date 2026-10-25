<template>
  <div class="topic-body">
    <h3>Hires</h3>
    <div class="dia src" role="img" aria-label="Hires by source: most came from Indeed, then the careers page, then referrals.">
      <div v-for="(s, i) in SOURCES" :key="s.name" class="bar">
        <span class="name">{{ s.name }}</span><span class="track"><i :style="{ width: `${s.pct}%`, animationDelay: `${i * 0.3}s` }" /></span><b>{{ s.n }}</b>
      </div>
    </div>
    <p>How hiring is going across your published jobs.</p>
    <ul>
      <li><b>Fill rate</b>: seats filled out of the openings you set on each job.</li>
      <li><b>Where hires came from</b>: read from the tag on each apply link. Give every place you post its own tagged link to see which ones work. Links without a tag show as “No source tag”.</li>
    </ul>
    <p>Live jobs come first, then the ones with the most seats left.</p>
  </div>
</template>

<script setup lang="ts">
const SOURCES = [{ name: 'Indeed', n: 6, pct: 100 }, { name: 'Careers page', n: 3, pct: 50 }, { name: 'Referral', n: 2, pct: 33 }]
</script>

<style scoped>
.bar { display: grid; grid-template-columns: 84px 1fr 18px; gap: 8px; align-items: center; }
.name { color: var(--ink); }
.track { height: 10px; border-radius: 5px; background: var(--surface); overflow: hidden; }
.track i { display: block; height: 100%; border-radius: 5px; background: var(--ok); animation: grow 5s var(--ease) infinite both; }
@keyframes grow { 0% { scale: 0 1; } 20%, 90% { scale: 1 1; } 100% { scale: 0 1; } }
.track i { transform-origin: left; }
b { text-align: right; font-variant-numeric: tabular-nums; }
</style>
