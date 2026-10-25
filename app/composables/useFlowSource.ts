import type { Ref } from 'vue'
import type { FieldType, FormField, Graph } from '~~/shared/workflow/types'

// What the canvas and the form builder edit: a job's draft, or a flow preset in the library.
export interface FlowSource {
  kind: 'job' | 'preset'
  form: Ref<FormField[] | null> // null until loaded
  workflow: Ref<Graph | null>
  save: (p: { form?: FormField[], workflow?: Graph }) => Promise<unknown> // fills in the half not passed
  readOnly: Ref<boolean>
  lockedKeys: Ref<Set<string>> // steps in the live flow: their key can't change
  lockedQuestions: Ref<Map<string, Set<string>>> // per live step, the keys its questions have there (rules and emails may read them)
  lockedFields: Ref<Map<string, FieldType>> // fields people have applied with
  lockVersion: Ref<number | null>
  missing: Ref<boolean> // the preset was deleted: nothing left to save to
  sample: Ref<{ title: string, openings: number, requirements?: object }>
  formHref: string
  flowHref: (node?: string) => string
}

export const useJobFlowSource = (id: string): FlowSource => {
  const { detail, editable, saveDraft } = useJob(id)
  return {
    kind: 'job',
    form: computed(() => editable.value?.form ?? null),
    workflow: computed(() => editable.value?.workflow ?? null),
    save: saveDraft,
    readOnly: computed(() => detail.value?.job.status === 'archived'),
    lockedKeys: computed(() => new Set(detail.value?.published?.workflow.nodes.map(n => n.key) ?? [])),
    lockedQuestions: computed(() => new Map((detail.value?.published?.workflow.nodes ?? []).map((n) => {
      const c = n.config as { scorecard?: { key: string }[], questions?: { key: string }[] } | undefined
      return [n.key, new Set([...(c?.scorecard ?? []), ...(c?.questions ?? [])].map(q => q.key))]
    }))),
    lockedFields: computed(() => new Map((detail.value?.published?.form ?? []).map(f => [f.key, f.type]))),
    lockVersion: computed(() => detail.value?.published?.version ?? null),
    missing: computed(() => false),
    sample: computed(() => ({ title: detail.value?.job.title ?? '', openings: detail.value?.job.openings ?? 1, requirements: detail.value?.job.requirements })),
    formHref: `/jobs/${id}/form`,
    flowHref: node => `/jobs/${id}/flow${node ? `?node=${node}` : ''}`,
  }
}

// ponytail: leaving the Flow tab fires an unmount save; a Form save within ~1 s of it can send the store's
// older workflow. Jobs have the same race through saveDraft; serialise saves here if it ever bites.
export const useFlowPresetSource = (id: string): FlowSource => {
  const { flowPresets, refresh, update } = useFlowPresets()
  const preset = computed(() => flowPresets.value?.find(p => p.id === id) ?? null)
  return {
    kind: 'preset',
    form: computed(() => preset.value?.form ?? null),
    workflow: computed(() => preset.value?.workflow ?? null),
    // the server takes a preset's form and flow together, never one half
    async save(p) {
      const base = preset.value
      if (!base) throw { status: 404, code: 'not_found', message: 'This flow preset was deleted.', issues: [] } satisfies ApiError
      try {
        return await update(id, { form: p.form ?? base.form, workflow: p.workflow ?? base.workflow })
      }
      catch (e) {
        // deleted elsewhere: reload the list so the hub shows that, then let the caller say "Not saved"
        if ((e as ApiError).status === 404) await refresh()
        throw e
      }
    },
    readOnly: computed(() => false),
    lockedKeys: computed(() => new Set()),
    lockedQuestions: computed(() => new Map()),
    lockedFields: computed(() => new Map()),
    lockVersion: computed(() => null),
    missing: computed(() => !!flowPresets.value && !preset.value),
    sample: computed(() => SAMPLE_JOB),
    formHref: `/library/flows/${id}/form`,
    flowHref: node => `/library/flows/${id}${node ? `?node=${node}` : ''}`,
  }
}

// Stands in for a job wherever there is none yet (step and flow presets), e.g. in email previews.
export const SAMPLE_JOB = { title: 'Example job', openings: 1, requirements: { must_have_skills: ['TypeScript'], min_experience_years: 3 } }
