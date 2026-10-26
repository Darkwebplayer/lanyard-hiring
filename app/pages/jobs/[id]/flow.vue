<script setup lang="ts">
import type { FormField, Graph } from '~~/shared/workflow/types'
import FlowEditor from '~/components/flow/FlowEditor.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const id = computed(() => String(route.params.id))
const { detail, editable, error, refresh, saveDraft } = useJob(id.value)
const source = useJobFlowSource(id.value)
if (!detail.value) refresh()
useHead({ title: () => (detail.value ? `Workflow · ${detail.value.job.title}` : 'Workflow') })

// ---------- replacing the draft with a preset: remount the editor on the new draft, with Undo ----------
type Flow = { form: FormField[], workflow: Graph }
const editor = ref<InstanceType<typeof FlowEditor>>()
const rev = ref(0)
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
let undoToast: number | null = null

async function put(next: Flow) {
  await editor.value?.flush()
  await saveDraft(next)
  rev.value++
  await router.replace({ query: { check: '1' } })
}
async function replace(next: Flow, name: string) {
  const hadDraft = !!detail.value?.draft
  const live = detail.value?.published?.version
  try {
    await editor.value?.flush()
    const prev = clone({ form: editable.value!.form, workflow: editable.value!.workflow })
    await put(next)
    toast.show(hadDraft || !live ? `Loaded “${name}” into the draft` : `Loaded “${name}” into a new draft. v${live} is unchanged.`, {
      label: 'Undo',
      run: () => put(prev).then(() => toast.show('Brought back the workflow you had')).catch(e => toast.show(toApiError(e).message)),
    }, 10000)
    undoToast = toast.queue.value.at(-1)?.id ?? null
  }
  catch (e) { toast.show(`The draft wasn’t replaced: ${toApiError(e).message}`) }
}
// Undo would throw away edits made after the load, so the first edit takes it away.
function onEdit() {
  if (undoToast === null) return
  toast.dismiss(undoToast)
  undoToast = null
}
</script>

<template>
  <div class="flow-page">
    <h2 class="sr-only">Workflow</h2>
    <FlowEditor v-if="editable" ref="editor" :key="`${id}:${rev}`" :source="source" stages-first @edit="onEdit" @replace="replace" />
    <div v-else-if="error" class="empty" role="alert">
      <h3>The workflow didn’t load</h3>
      <p>{{ error.message }}</p>
      <button type="button" class="btn" @click="refresh">Retry</button>
    </div>
    <div v-else-if="detail" class="empty">
      <h3>This job has no workflow yet</h3>
    </div>
    <div v-else class="loading" aria-busy="true" aria-label="Loading the flow">
      <div class="skeleton pal" />
      <div class="cards">
        <div v-for="i in 4" :key="i" class="skeleton card-sk" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-page { min-width: 0; }
.loading { display: grid; grid-template-columns: 220px 1fr; height: max(560px, calc(100dvh - 160px)); border-top: 1px solid var(--line); }
.pal { border-radius: 0; }
.cards { display: grid; justify-items: center; align-content: start; gap: 64px; padding-top: 56px; background: var(--bg); }
.card-sk { width: 240px; height: 96px; border-radius: 16px; }
</style>
