<script setup lang="ts">
const { inbox, error, refresh } = useTasks()
const { isManager } = useMe()
const route = useRoute()
const flash = useState<{ at: string } | null>('inbox-flash', () => null)

// with tasks waiting, the first one opens by itself; nobody starts from a blank page
const router = useRouter()
const first = computed(() => inbox.value?.mine.find(t => t.nodeType !== 'request_documents')) // those open on the candidate page
const opening = computed(() => !!first.value && route.query.list !== 'attention')
// after mount, so it never races the navigation that brought us here
onMounted(async () => {
  await router.isReady()
  watch(() => opening.value && first.value!.runId, (id) => {
    if (id) router.replace({ path: `/inbox/${id}`, query: route.query })
  }, { immediate: true })
})
const cleared = computed(() => flash.value?.at === '/inbox')
const retrying = ref(false)
async function retry() {
  retrying.value = true
  await refresh()
  retrying.value = false
}
</script>

<template>
  <div v-if="(!inbox && !error) || opening" class="sk" aria-hidden="true">
    <div class="card sk-card sk-head">
      <span class="skeleton" style="width:44px;height:44px;border-radius:50%" />
      <div class="sk-lines"><span class="skeleton" style="height:22px;width:62%" /><span class="skeleton" style="height:14px;width:40%" /></div>
    </div>
    <div class="card sk-card sk-lines">
      <span v-for="i in 4" :key="i" class="skeleton" :style="{ height: '14px', width: `${70 - i * 9}%` }" />
    </div>
  </div>

  <div v-else-if="!inbox" class="empty">
    <h2>Your tasks didn’t load</h2>
    <p>{{ error?.message }}</p>
    <button class="btn" :aria-busy="retrying" @click="retry"><span v-if="retrying" class="spinner" /><Icon v-else name="retry" />Retry</button>
  </div>

  <div v-else-if="inbox.mine.length || route.query.list === 'attention'" class="empty">
    <p>Choose a late or blocked task to see its scorecard.</p>
  </div>

  <div v-else class="empty end">
    <span class="badge" :data-slot="cleared ? 'ok' : 'none'" aria-hidden="true" />
    <h2>{{ cleared ? 'You’re clear' : 'No tasks yet' }}</h2>
    <p v-if="cleared">Nothing waits on you right now. New tasks appear here when a candidate reaches a step assigned to you.</p>
    <p v-else>When a candidate reaches a step assigned to you, it appears here.</p>
    <NuxtLink v-if="isManager" to="/jobs" class="btn">See how your jobs are moving<Icon name="arrow-right" /></NuxtLink>
  </div>
</template>

<style scoped>
.sk { display: grid; gap: 20px; }
.sk-card { padding: 28px; }
.sk-head { display: flex; gap: 16px; align-items: center; }
.sk-lines { display: grid; gap: 12px; flex: 1; }
.end { padding-top: 12vh; }
/* the product's badge, blank: nothing to act on */
.badge { position: relative; width: 56px; height: 72px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line-2); box-shadow: var(--shadow-2); margin-bottom: 8px; }
.badge::before { top: 10px; width: 20px; }
</style>
