<script setup lang="ts">
// Must-have skills as chips: type and press Enter or comma; a pasted list splits; Backspace on empty removes the last.
const skills = defineModel<string[]>({ required: true })
defineProps<{ id: string, placeholder?: string }>()
const skill = ref('')
function addSkills(text: string) {
  for (const s of text.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!skills.value.some(x => x.toLowerCase() === s.toLowerCase())) skills.value.push(s)
  }
  skill.value = ''
}
function onSkillKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    addSkills(skill.value)
  }
  else if (e.key === 'Backspace' && !skill.value) skills.value.pop()
}
function onSkillPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text') ?? ''
  if (!text.includes(',')) return
  e.preventDefault()
  addSkills(skill.value + text)
}
</script>

<template>
  <div class="chips-input" @click="($event.currentTarget as HTMLElement).querySelector('input')?.focus()">
    <span v-for="(s, i) in skills" :key="s" class="chip">
      {{ s }}<button type="button" class="x" :aria-label="`Remove ${s}`" @click.stop="skills.splice(i, 1)"><Icon name="x" :size="12" /></button>
    </span>
    <input :id="id" v-model="skill" :placeholder="skills.length ? '' : placeholder" @keydown="onSkillKey" @paste="onSkillPaste" @blur="addSkills(skill)">
  </div>
</template>

<style scoped>
.chips-input {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: var(--h-md); padding: 5px 8px;
  border: 1px solid var(--line-2); border-radius: var(--r-field); background: var(--surface); cursor: text;
}
.chips-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent); }
.chips-input input { flex: 1 1 120px; min-height: 26px; padding: 0 4px; border: 0; box-shadow: none !important; background: none; }
.chips-input .chip { height: 26px; padding-right: 3px; font-size: var(--t-sm); color: var(--ink); }
.x { display: grid; place-items: center; width: 24px; height: 24px; margin: -2px -4px -2px -2px; border: 0; border-radius: 50%; background: none; color: var(--ink-2); cursor: pointer; }
.x:hover { background: var(--line); color: var(--ink); }
fieldset:disabled .x { display: none; }
</style>
