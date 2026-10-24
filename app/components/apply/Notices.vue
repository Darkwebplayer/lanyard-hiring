<script setup lang="ts">
// The two texts from Settings, as they sit at the bottom of the apply form. Settings shows the same component as its preview.
defineProps<{ consentText: string | null, aiNoticeText: string | null, preview?: boolean }>()
const consent = defineModel<boolean>({ default: false })
</script>

<template>
  <div v-if="aiNoticeText || consentText" class="notices">
    <p v-if="aiNoticeText" class="ai"><Icon name="ai" :size="16" /><span>{{ aiNoticeText }}</span></p>
    <label v-if="consentText" class="check consent">
      <input v-model="consent" name="consent" type="checkbox" :tabindex="preview ? -1 : undefined" :required="!preview">
      <span>{{ consentText }}</span>
    </label>
  </div>
</template>

<style scoped>
.notices { display: grid; gap: 16px; padding-top: 20px; border-top: 1px solid var(--line); }
.ai { display: flex; gap: 10px; color: var(--ink-2); font-size: var(--t-sm); white-space: pre-line; }
.ai svg { flex: none; margin-top: 1px; }
.consent { font-size: var(--t-sm); white-space: pre-line; }
</style>
