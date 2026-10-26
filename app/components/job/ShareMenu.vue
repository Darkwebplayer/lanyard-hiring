<script setup lang="ts">
// Every way to get a job in front of people, in one menu on the job header. Each link carries ?src=… so the
// applicant's source shows on their profile and in Reports.
import type { JobStatus } from '~/composables/useJob'

const props = defineProps<{ jobId: string, title: string, status: JobStatus, published: boolean }>()
const open = computed(() => props.status === 'open' && props.published)
const link = computed(() => applyUrl(props.jobId))
const tagged = (src: string) => `${link.value}?src=${encodeURIComponent(src)}`
const linkedIn = computed(() => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(tagged('linkedin'))}`)
const feed = computed(() => `${import.meta.client ? location.origin : ''}/feeds/jobs.xml`)
const reason = computed(() => props.status === 'draft' || !props.published
  ? 'Publish the job and open applications first. Until then nobody can apply.'
  : 'Applications are closed. Open them from Status to share this job again.')

// "Facebook group" → "facebook-group"
const where = ref('')
const slug = computed(() => where.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40))
const whereEl = ref<HTMLInputElement>()
const whereError = ref('')

// one "Copied" at a time, in place on the button that was pressed
const copied = ref<{ key: string, ok: boolean } | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
async function copy(key: string, text: string) {
  const ok = await copyText(text)
  copied.value = { key, ok }
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = null), ok ? 2000 : 4000)
}
const label = (key: string, idle: string) => (copied.value?.key === key ? (copied.value.ok ? 'Copied' : 'Copy failed') : idle)
function copyTagged() {
  if (!slug.value) {
    whereError.value = 'Say where you’ll post it, like “Facebook group”.'
    whereEl.value?.focus()
    return
  }
  copy('tagged', tagged(slug.value))
}
</script>

<template>
  <button class="btn share-btn" popovertarget="job-share-menu"><Icon name="link" />Share job<Icon name="chevron-down" /></button>
  <div id="job-share-menu" popover class="share" role="dialog" aria-labelledby="share-h">
    <h2 id="share-h">Share {{ title }}</h2>
    <p v-if="!open" class="closed"><Icon name="lock" :size="16" />{{ reason }}</p>
    <template v-else>
      <div class="row">
        <span class="logo" style="--logo: var(--ink)" aria-hidden="true"><Icon name="link" :size="16" /></span>
        <span class="what"><b>Apply link</b><small class="mono url">{{ link }}</small></span>
        <button type="button" class="btn btn-sm" @click="copy('link', link)">
          <Icon :name="copied?.key === 'link' ? (copied.ok ? 'check' : 'alert') : 'copy'" /><span aria-live="polite">{{ label('link', 'Copy') }}</span>
        </button>
      </div>
      <div class="row">
        <span class="logo" style="--logo: #0a66c2" aria-hidden="true">in</span>
        <span class="what"><b>LinkedIn</b><small>Opens a post with the link, tagged “LinkedIn”</small></span>
        <a class="btn btn-sm" :href="linkedIn" target="_blank" rel="noopener">Post<Icon name="external" /></a>
      </div>
      <div class="row">
        <span class="logo" style="--logo: #2557a7" aria-hidden="true"><Icon name="download" :size="16" /></span>
        <span class="what"><b>Indeed and other job boards</b><small>Give them your job feed once; new jobs follow by themselves</small></span>
        <button type="button" class="btn btn-sm" @click="copy('feed', feed)">
          <Icon :name="copied?.key === 'feed' ? (copied.ok ? 'check' : 'alert') : 'copy'" /><span aria-live="polite">{{ label('feed', 'Copy feed') }}</span>
        </button>
      </div>
      <div class="row">
        <span class="logo" style="--logo: oklch(0.5 0.12 155)" aria-hidden="true"><Icon name="search" :size="16" /></span>
        <span class="what"><b>Google job search</b><small>Listed while the job is open</small></span>
        <span class="chip chip-ok">On</span>
      </div>
      <form class="where" @submit.prevent="copyTagged">
        <label for="share-where">Link for somewhere else</label>
        <div class="where-row">
          <input
            id="share-where" ref="whereEl" v-model="where" placeholder="Facebook group" maxlength="60" autocomplete="off"
            :aria-invalid="whereError ? 'true' : undefined" aria-describedby="share-where-h" @input="whereError = ''"
          >
          <button class="btn btn-sm">
            <Icon :name="copied?.key === 'tagged' ? (copied.ok ? 'check' : 'alert') : 'copy'" /><span aria-live="polite">{{ label('tagged', 'Copy tagged link') }}</span>
          </button>
        </div>
        <p v-if="whereError" id="share-where-h" class="error">{{ whereError }}</p>
        <p v-else id="share-where-h" class="hint">{{ slug ? `Applicants from it show the source “${slug}”.` : 'Applicants show where they came from in Reports.' }}</p>
      </form>
    </template>
  </div>
</template>

<style scoped>
.share-btn { anchor-name: --job-share; }
.share {
  position-anchor: --job-share; inset: auto; top: anchor(bottom); right: anchor(right); margin-top: 6px;
  width: min(440px, calc(100vw - 32px)); padding: 18px; display: none; gap: 4px;
  /* the .menu look without its full-width button rule, which would flatten the .btn buttons inside */
  border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--surface); color: var(--ink); box-shadow: var(--shadow-3);
  position-try-fallbacks: flip-block, flip-inline;
}
.share:popover-open { display: grid; }
.share h2 { font-size: var(--t-lg); margin-bottom: 8px; overflow-wrap: anywhere; }
.closed { display: flex; gap: 8px; align-items: flex-start; color: var(--ink-2); }
.closed svg { flex: none; margin-top: 2px; }
.row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
.row + .row { border-top: 1px solid var(--line); }
/* a coloured square per place, so the eye finds LinkedIn or Indeed before reading */
.logo { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: 9px; background: var(--logo); color: #fff; font-weight: 700; font-size: var(--t-sm); }
.what { flex: 1; min-width: 0; display: grid; gap: 1px; }
.what small { font-size: var(--t-sm); color: var(--ink-2); }
.url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.row .btn { flex: none; }
.where { display: grid; gap: 6px; padding-top: 12px; margin-top: 4px; border-top: 1px solid var(--line); }
.where label { font-weight: 600; font-size: var(--t-sm); }
.where-row { display: flex; gap: 8px; }
.where-row input { flex: 1; min-width: 0; height: var(--h-sm); }
.where .hint { font-size: var(--t-sm); color: var(--ink-2); }
.where .error { font-size: var(--t-sm); color: var(--bad); font-weight: 500; }
</style>
