<script setup lang="ts">
// The job description: a textarea with a formatting toolbar and a preview drawn by the same renderer
// the apply page uses, so what the recruiter previews is exactly what candidates get.
const model = defineModel<string>({ required: true })
const props = defineProps<{ id: string, disabled?: boolean, maxlength?: number }>()
const ta = ref<HTMLTextAreaElement>()
const mode = ref<'write' | 'preview'>('write')
const preview = computed(() => renderMarkdown(model.value || ''))
const mac = import.meta.client && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = mac ? '⌘' : 'Ctrl+'

// Replaces the selection, keeps it selected, and leaves an undo step in the browser's history.
function replace(start: number, end: number, text: string, selStart: number, selEnd: number) {
  const el = ta.value!
  el.focus()
  el.setSelectionRange(start, end)
  if (!document.execCommand('insertText', false, text)) el.setRangeText(text, start, end, 'end') // execCommand keeps native undo
  model.value = el.value
  nextTick(() => el.setSelectionRange(selStart, selEnd))
}

function wrap(before: string, after = before, placeholder = 'text') {
  const el = ta.value!
  const { selectionStart: s, selectionEnd: e, value } = el
  const picked = value.slice(s, e) || placeholder
  replace(s, e, before + picked + after, s + before.length, s + before.length + picked.length)
}

// Prefixes every selected line ("- ", "1. ", "## "); pressing again on prefixed lines removes it.
function prefix(kind: 'ul' | 'ol' | 'h') {
  const el = ta.value!
  const { value } = el
  const s = value.lastIndexOf('\n', el.selectionStart - 1) + 1
  const eIdx = value.indexOf('\n', el.selectionEnd)
  const e = eIdx === -1 ? value.length : eIdx
  const lines = value.slice(s, e).split('\n')
  const re = kind === 'ul' ? /^[-*–]\s+/ : kind === 'ol' ? /^\d+[.)]\s+/ : /^#{1,3}\s+/
  const all = lines.every(l => re.test(l))
  const next = lines.map((l, i) => all ? l.replace(re, '') : (kind === 'ul' ? '- ' : kind === 'ol' ? `${i + 1}. ` : '## ') + l.replace(re, '')).join('\n')
  replace(s, e, next, s, s + next.length)
}

function link() {
  const el = ta.value!
  const { selectionStart: s, selectionEnd: e, value } = el
  const label = value.slice(s, e) || 'link text'
  const text = `[${label}](https://)`
  // select the URL part so typing replaces it
  replace(s, e, text, s + label.length + 3, s + text.length - 1)
}

function onKey(ev: KeyboardEvent) {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return
  const k = ev.key.toLowerCase()
  if (k === 'b') { ev.preventDefault(); wrap('**', '**', 'bold text') }
  else if (k === 'i') { ev.preventDefault(); wrap('*', '*', 'italic text') }
  else if (k === 'k') { ev.preventDefault(); link() }
}

const TOOLS = [
  { label: 'Heading', icon: 'H', run: () => prefix('h') },
  { label: `Bold (${mod}B)`, icon: 'B', run: () => wrap('**', '**', 'bold text') },
  { label: `Italic (${mod}I)`, icon: 'I', run: () => wrap('*', '*', 'italic text') },
  { label: 'Bulleted list', icon: 'list', run: () => prefix('ul') },
  { label: 'Numbered list', icon: 'olist', run: () => prefix('ol') },
  { label: `Link (${mod}K)`, icon: 'link', run: link },
]
</script>

<template>
  <div class="md" :class="{ disabled: props.disabled }">
    <div class="bar">
      <div class="seg" role="radiogroup" :aria-label="`Description view`">
        <label><input v-model="mode" type="radio" :name="`${id}-mode`" value="write"><span>Write</span></label>
        <label><input v-model="mode" type="radio" :name="`${id}-mode`" value="preview"><span>Preview</span></label>
      </div>
      <div v-show="mode === 'write'" class="tools" role="toolbar" aria-label="Formatting" :aria-controls="id">
        <button
          v-for="t in TOOLS" :key="t.label" type="button" class="tool" :title="t.label" :aria-label="t.label"
          :disabled="props.disabled" @mousedown.prevent @click="t.run"
        >
          <b v-if="t.icon === 'B'">B</b><i v-else-if="t.icon === 'I'">I</i><span v-else-if="t.icon === 'H'" class="h">H</span>
          <svg v-else-if="t.icon === 'olist'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M10 6h11M10 12h11M10 18h11M4 4.5h1.5V9M4 9h3M4 15.5c.4-.6 1-1 1.7-1 .9 0 1.5.6 1.5 1.3 0 1.4-3.2 2-3.2 3.7h3.3" /></svg>
          <svg v-else-if="t.icon === 'list'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.5" /></svg>
          <Icon v-else :name="t.icon" :size="16" />
        </button>
      </div>
    </div>
    <textarea
      v-show="mode === 'write'" :id="id" ref="ta" v-model="model" :disabled="props.disabled" :maxlength="maxlength"
      rows="12" spellcheck="true" placeholder="What the person will do, the team, what you look for…" @keydown="onKey"
    />
    <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapes all HTML first -->
    <div v-if="mode === 'preview'" class="prose preview" v-html="preview || '<p class=&quot;faint&quot;>Nothing to preview yet.</p>'" />
    <p class="help"><span>**bold**</span><span>*italic*</span><span># heading</span><span>- list</span><span>[link](https://…)</span></p>
  </div>
</template>

<style scoped>
.md { display: grid; gap: 0; border: 1px solid var(--line-2); border-radius: var(--r-field); background: var(--surface); overflow: hidden; }
.md:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint), 0 0 0 1px var(--accent); }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px; border-bottom: 1px solid var(--line); background: var(--sunk); }
.bar .seg { background: var(--hover); }
.tools { display: flex; gap: 2px; }
.tool {
  display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: var(--ink-2);
  font: 600 14px/1 var(--font); cursor: pointer;
}
.tool:hover:not(:disabled) { background: var(--surface); color: var(--ink); }
.tool i { font-family: Georgia, serif; font-size: 15px; }
.tool .h { font-size: 13px; letter-spacing: -0.02em; }
textarea { border: 0; border-radius: 0; min-height: 260px; max-height: 40rem; padding: 14px 16px; line-height: 1.6; box-shadow: none; }
.preview { min-height: 260px; padding: 14px 16px; }
.help { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 8px 14px; border-top: 1px solid var(--line); font: var(--t-xs) var(--mono); color: var(--ink-3); }
.disabled { background: var(--sunk); }
</style>
