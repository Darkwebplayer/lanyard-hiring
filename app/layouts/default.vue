<script setup lang="ts">
import { createAuthClient } from 'better-auth/vue'

const { me, isManager, isAdmin, canAsk } = useMe()
const { open: asking, floats } = useAsk()
const { inbox, refresh } = useTasks()
const route = useRoute()
if (!inbox.value) refresh()

const places = computed(() => [
  { to: '/inbox', label: 'Inbox', icon: 'inbox', count: inbox.value?.mine.length ?? 0, show: true },
  { to: '/jobs', label: 'Jobs', icon: 'jobs', show: isManager.value },
  { to: '/library', label: 'Library', icon: 'library', show: isManager.value },
  { to: '/hires', label: 'Hires', icon: 'hires', show: isManager.value },
  { to: '/team', label: 'Team', icon: 'team', show: isAdmin.value },
  { to: '/settings', label: 'Settings', icon: 'settings', show: isAdmin.value },
].filter(p => p.show))

const current = (to: string) => route.path === to || route.path.startsWith(`${to}/`)
  || (to === '/jobs' && route.path.startsWith('/candidates') && isManager.value)

async function signOut() {
  await createAuthClient().signOut()
  me.value = null
  await navigateTo('/login')
}
</script>

<template>
  <div class="shell" :class="{ asking: asking && !floats && (canAsk || isAdmin) }">
    <nav class="rail" aria-label="Main">
      <NuxtLink to="/inbox" class="mark" aria-label="Lanyard, go to inbox">
        <span class="mark-slot" />
        <span class="mark-word">Lanyard</span>
      </NuxtLink>
      <ul>
        <li v-for="p in places" :key="p.to">
          <NuxtLink :to="p.to" :aria-current="current(p.to) ? 'page' : undefined">
            <span class="ico"><Icon :name="p.icon" :size="20" /><b v-if="p.count" class="count">{{ p.count > 99 ? '99+' : p.count }}</b></span>
            <span class="lbl">{{ p.label }}</span>
          </NuxtLink>
        </li>
      </ul>
      <button v-if="me" class="me" popovertarget="me-menu" :aria-label="`${me.name}, account menu`">
        <Avatar :name="me.name" :image="me.image" :size="36" />
      </button>
      <div v-if="me" id="me-menu" popover class="menu me-menu">
        <div class="who"><b>{{ me.name }}</b><span class="faint">{{ me.email }}</span></div>
        <hr>
        <button @click="signOut"><Icon name="logout" />Sign out</button>
      </div>
    </nav>
    <main class="main">
      <slot />
    </main>
    <AskPanel />
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); min-height: 100dvh; min-width: 960px; }
/* Ask docks beside the page when there is room for both; below 1280 px it lies over the right edge */
@media (min-width: 1280px) { .shell.asking { grid-template-columns: var(--rail) minmax(0, 1fr) 392px; } }
.rail {
  position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 14px 0 16px; border-right: 1px solid var(--line); background: var(--bg);
}
.mark { display: grid; justify-items: center; gap: 4px; padding: 8px 6px 14px; text-decoration: none; color: var(--ink); }
.mark-slot {
  position: relative; width: 30px; height: 36px; border-radius: 9px; background: var(--ink);
}
.mark-slot::before { content: ""; position: absolute; top: 6px; left: 50%; translate: -50% 0; width: 12px; height: 4px; border-radius: 4px; background: var(--accent); }
.mark-word { font-size: 11px; font-weight: 700; letter-spacing: 0.02em; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
ul a {
  position: relative; display: grid; justify-items: center; gap: 4px; width: 72px; padding: 8px 0 7px; border-radius: 16px;
  color: var(--ink-2); text-decoration: none; font-size: var(--t-xs); font-weight: 600;
  transition: background var(--t-micro) var(--ease), color var(--t-micro) var(--ease);
}
ul a:hover { color: var(--ink); background: var(--hover); }
.ico { position: relative; display: grid; place-items: center; width: 44px; height: 30px; border-radius: var(--r-pill); transition: background var(--t-micro) var(--ease); }
ul a[aria-current="page"] { color: var(--ink); }
ul a[aria-current="page"] .ico { background: var(--surface); box-shadow: var(--shadow-1), 0 0 0 1px var(--line); color: var(--accent-ink); }
.count {
  position: absolute; top: -3px; right: -2px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: var(--accent); color: #fff; font-size: 10.5px; line-height: 18px; text-align: center; box-shadow: 0 0 0 2px var(--bg);
  font-variant-numeric: tabular-nums;
}
.me { margin-top: auto; padding: 3px; border: 0; background: none; border-radius: 50%; cursor: pointer; }
.me-menu { position-anchor: auto; inset: auto; left: calc(var(--rail) - 6px); bottom: 16px; }
.who { display: grid; padding: 8px 10px 4px; font-size: var(--t-sm); }
.main { min-width: 0; }
</style>
