<template>
  <div class="topic-body">
    <h3>How a stage works</h3>
    <div class="dia sd" role="img" aria-label="A person enters the stage. Lanyard acts first, then a person works, then a rule moves them to the next stage.">
      <div class="b"><em class="m" aria-hidden="true"><Icon name="ai" :size="11" /></em>First, Lanyard does these</div>
      <div class="b"><em class="p" aria-hidden="true"><Icon name="person" :size="11" /></em>Then a person does these</div>
      <div class="b"><em class="r" aria-hidden="true"><Icon name="arrow-right" :size="11" /></em>A rule picks where they go next</div>
      <div class="outs"><span>Interview</span><span>Decision</span></div>
      <span class="dot" aria-hidden="true" />
    </div>
    <p>Each stage is a column on your board. Everyone who reaches it goes through its steps, top to bottom: <b>Automated actions</b>, then <b>Assigned tasks</b>, then <b>Advancement rules</b>.</p>

    <h4 id="manual">Why “Manual review” doesn’t get everyone</h4>
    <div class="bands" role="img" aria-label="A score under 40 goes to Decision, 40 to 69 goes to a person for manual review, 70 and up goes to Interview.">
      <span class="lo">Under 40 · closed</span>
      <span class="mid">40–69 · you</span>
      <span class="hi">70+ · interview</span>
    </div>
    <p>An assigned task only gets the people a rule sends to it. In the AI screening workflow, the AI screening step moves clear yeses and clear nos on by itself. <b>Only the middle band waits for you.</b> Change the numbers in “Advancement rules”.</p>

    <h4 id="decision">Decision sends one email, not both</h4>
    <p>The Decision stage lists the offer email and the rejection email, but a candidate gets <b>one or the other</b>, depending on the path that brought them there. Closing someone by hand sends no email at all.</p>

    <h4>Changes and Publish</h4>
    <p>Edits save to a draft as you go. They reach new applicants when you <b>Publish</b>. People already in keep the version they started on.</p>
  </div>
</template>

<style scoped>
.sd { padding-right: 40px; }
.b { position: relative; padding: 8px 10px 8px 36px; border-radius: var(--r-field); background: var(--surface); animation: lit 6s var(--ease) infinite; }
.b:nth-of-type(2) { animation-delay: 1.5s; }
.b:nth-of-type(3) { animation-delay: 3s; }
@keyframes lit { 0%, 22% { box-shadow: inset 0 0 0 1.5px var(--accent); color: var(--ink); } 26%, 100% { box-shadow: none; color: var(--ink-2); } }
.b em { position: absolute; left: 10px; top: 50%; translate: 0 -50%; width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; color: #fff; }
.m { background: var(--machine); } .p { background: var(--accent); } .r { background: var(--ink-3); }
.outs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 4px; }
.outs span { padding: 6px; border-radius: var(--r-pill); background: var(--ink); color: #fff; text-align: center; opacity: 0.25; }
.outs span:first-child { animation: out 6s var(--ease) infinite; }
@keyframes out { 0%, 70% { opacity: 0.25; } 75%, 95% { opacity: 1; } 100% { opacity: 0.25; } }
.dot { position: absolute; right: 14px; top: 20px; width: 14px; height: 14px; border-radius: 50%; background: var(--accent); animation: drop 6s var(--ease) infinite; }
@keyframes drop { 0% { top: 22px; } 25% { top: 60px; } 50% { top: 98px; } 70%, 95% { top: 138px; opacity: 1; } 100% { top: 138px; opacity: 0; } }
.bands { display: grid; grid-template-columns: 40fr 30fr 30fr; border-radius: var(--r-field); overflow: hidden; font-size: var(--t-xs); font-weight: 600; text-align: center; }
.bands span { padding: 8px 4px; }
.lo { background: var(--sunk); color: var(--ink-2); } .mid { background: var(--accent); color: #fff; } .hi { background: var(--ink); color: #fff; }
/* still frame: the person step lit, the dot gone, one way out */
@media (prefers-reduced-motion: reduce) {
  .dot { display: none; }
  .b:nth-of-type(2) { box-shadow: inset 0 0 0 1.5px var(--accent); color: var(--ink); }
  .outs span:first-child { opacity: 1; }
}
</style>
