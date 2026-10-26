<script setup lang="ts">
import type { PipelineState } from '../[id].vue'
import { loadNames } from '~/components/pipeline/BoardMoveDialog.vue'

const route = useRoute()
const router = useRouter()
const id = route.params.id as string
const { detail } = useJob(id)
const { board, error, load } = inject<PipelineState>('pipeline')!
const { isManager } = useMe()

// Board or List, in the URL so a link (or "See them in the list") opens the same view
const view = computed(() => route.query.view === 'list' ? 'list' : 'board')
const setView = (v: 'board' | 'list') => router.replace({ query: v === 'list' ? { ...route.query, view: 'list' } : {} })

const total = computed(() => board.value?.counts.reduce((n, c) => n + c.n, 0) ?? 0)
const live = computed(() => detail.value?.job.status === 'open')
const everPublished = computed(() => !!detail.value?.published)
// what a move sets off is read from the flow people are on now: the published one
const graph = computed(() => detail.value?.published?.workflow ?? null)

// team names, so "goes to 1 person" can say who; managers only (the board's moves are theirs anyway)
const names = ref(new Map<string, string>())
watchEffect(async () => { if (isManager.value) names.value = await loadNames() })
const nameOf = (uid: string) => names.value.get(uid)
</script>

<template>
  <div>
    <div v-if="error" class="form-error" role="alert">
      <Icon name="alert" />{{ error.message }} <button class="btn btn-sm" @click="load">Retry</button>
    </div>

    <div v-else-if="!board || !detail" class="panel" aria-busy="true">
      <div v-for="i in 8" :key="i" class="sk-row"><span class="skeleton" style="width: 22%" /><span class="skeleton" style="width: 18%" /><span class="skeleton" style="width: 16%" /><span class="skeleton" style="width: 10%" /></div>
    </div>

    <section v-else-if="!total" class="panel empty">
      <template v-if="!everPublished">
        <h2>No applications yet</h2>
        <p>Publish the job to start taking applications.</p>
      </template>
      <template v-else-if="live">
        <h2>No applications yet</h2>
        <p>Share the apply link wherever you post the job.</p>
        <JobCopyLink :job-id="id" class="empty-link" />
        <p v-if="isManager" class="or">Have people from somewhere else? <NuxtLink :to="`/jobs/${id}/import`">Import them from a spreadsheet</NuxtLink></p>
      </template>
      <template v-else>
        <h2>No applications</h2>
        <p>Nobody applied while the job was open.</p>
      </template>
    </section>

    <template v-else>
      <div class="views">
        <div class="seg" role="radiogroup" aria-label="View">
          <label><input type="radio" name="view" value="board" :checked="view === 'board'" @change="setView('board')"><span>Board</span></label>
          <label><input type="radio" name="view" value="list" :checked="view === 'list'" @change="setView('list')"><span>List</span></label>
        </div>
        <NuxtLink v-if="isManager && everPublished" :to="`/jobs/${id}/import`" class="btn btn-sm import"><Icon name="upload" />Import candidates</NuxtLink>
      </div>

      <PipelineBoard v-if="view === 'board'" :job-id="id" :board="board" :graph="graph" :name-of="nameOf" @reload="load" />
      <PipelineList v-else :job-id="id" :board="board" :graph="graph" :name-of="nameOf" @reload="load" />
    </template>
  </div>
</template>

<style scoped>
.views { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.import { margin-left: auto; }
.empty-link { width: min(520px, 100%); margin-top: 6px; }
.or { margin-top: 8px; font-size: var(--t-sm); }
.sk-row { display: flex; gap: 32px; padding: 16px; border-bottom: 1px solid var(--line); }
.sk-row:last-child { border-bottom: 0; }
.sk-row .skeleton { height: 14px; }
.form-error .btn { margin-left: auto; }
</style>
