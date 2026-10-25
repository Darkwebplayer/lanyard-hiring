<script setup lang="ts">
import { createAuthClient } from 'better-auth/vue'

definePageMeta({ layout: 'bare' })
useHead({ title: 'Sign in' })

const route = useRoute()
const busy = ref(false)
const failed = ref(false)
// each refusal shakes the badge once; a new key restarts the shake on a second failure
const shakes = ref(0)

// Better Auth sends refused sign-ins back with ?error=CODE (compared case-insensitively)
const refusal = computed(() => {
  const code = String(route.query.error ?? '').toUpperCase()
  if (!code) return null
  if (code === 'NOT_INVITED') return 'This Google account hasn’t been invited. Ask your admin to invite the address you signed in with.'
  if (code === 'EMAIL_NOT_VERIFIED') return 'Google hasn’t verified this email address yet. Verify it with Google, then try again.'
  if (code === 'NO_ACCESS') return 'Your account is switched off or has no role. Ask your admin to give you access.'
  return 'Sign-in didn’t finish. Try again.'
})

async function signIn() {
  busy.value = true
  failed.value = false
  const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/inbox'
  try {
    await createAuthClient().signIn.social({ provider: 'google', callbackURL: next, errorCallbackURL: '/login' })
  }
  catch {
    failed.value = true
    busy.value = false
    shakes.value++
  }
}
</script>

<template>
  <main class="login">
    <!-- the same badge as the boot screen: it swings when shown to Google and shakes once when the reader says no -->
    <div class="hang" :class="{ swing: busy }" aria-hidden="true">
      <span class="strap" /><span :key="shakes" class="badge" :class="{ no: refusal || failed }" />
    </div>
    <section class="card pass" aria-labelledby="t">
      <p class="eyebrow">Lanyard · hiring</p>
      <h1 id="t">Sign in</h1>
      <p class="muted">Use the Google account your invite was sent to.</p>
      <p v-if="refusal" class="form-error" role="alert"><Icon name="alert" :size="16" />{{ refusal }}</p>
      <p v-if="failed" class="form-error" role="alert"><Icon name="alert" :size="16" />Can’t reach Google right now. Check your connection and try again.</p>
      <button class="btn btn-dark btn-lg google" :aria-busy="busy" :disabled="busy" @click="signIn">
        <span v-if="busy" class="spinner" />
        <svg v-else width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
        <span>{{ busy ? 'Opening Google…' : 'Continue with Google' }}</span>
      </button>
    </section>
  </main>
</template>

<style scoped>
.login { min-height: 100dvh; display: grid; place-content: center; justify-items: center; gap: 22px; padding: 24px 16px; }
.hang { display: grid; justify-items: center; transform-origin: 50% 0; }
.strap { width: 2px; height: 56px; margin-bottom: -18px; border-radius: 2px; background: color-mix(in oklch, var(--ink) 35%, transparent); }
.badge { position: relative; width: 56px; height: 68px; border-radius: 16px; background: var(--ink); box-shadow: 0 8px 24px oklch(0.3 0.04 330 / 0.18); }
/* the slot stays magenta on a refusal: it means "a person acts" everywhere; the words carry the no */
.badge::before { content: ""; position: absolute; top: 11px; left: 50%; translate: -50% 0; width: 22px; height: 7px; border-radius: 7px; background: var(--accent); }
.swing { animation: present 1s cubic-bezier(.2, .8, .2, 1) both; }
.no { animation: no 380ms cubic-bezier(.36, .07, .19, .97) both; }
@keyframes present { 35% { rotate: -6deg; translate: 0 -2px; } 70% { rotate: 3deg; translate: 0 0; } }
@keyframes no { 20% { translate: -6px 0; } 40% { translate: 5px 0; } 60% { translate: -4px 0; } 80% { translate: 2px 0; } }
.pass { width: min(400px, 100%); padding: 36px 32px 32px; display: grid; gap: 12px; }
.pass h1 { font-size: var(--t-3xl); letter-spacing: -0.025em; }
.google { margin-top: 12px; width: 100%; }
</style>
