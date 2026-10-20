import type { Requirements } from '~~/shared/workflow/job'
import type { FormField, Graph } from '~~/shared/workflow/types'

export type JobStatus = 'draft' | 'open' | 'closed' | 'archived'
export interface Job {
  id: string, title: string, description: string, requirements: Requirements, openings: number
  status: JobStatus, closesAt: string | null, ownerId: string, publishedVersionId: string | null, createdAt: string
}
export interface Version {
  id: string, jobId: string, version: number, status: 'draft' | 'published'
  form: FormField[], workflow: Graph, requirements: Requirements, publishedAt: string | null, createdAt: string
}
export interface JobDetail { job: Job, draft: Version | null, published: Version | null }

// The job hub's data, shared by its tabs (pipeline, flow, form, details) so it loads once per job.
export const useJob = (id: MaybeRefOrGetter<string>) => {
  const detail = useState<JobDetail | null>(`job:${toValue(id)}`, () => null)
  const error = useState<ApiError | null>(`job-error:${toValue(id)}`, () => null)
  async function refresh() {
    try {
      detail.value = await api<JobDetail>(`/api/jobs/${toValue(id)}`)
      error.value = null
    }
    catch (e) {
      error.value = e as ApiError
    }
  }
  // The version being edited: the draft, else a copy of the published one (saving it opens draft N+1).
  const editable = computed(() => detail.value?.draft ?? detail.value?.published ?? null)

  // Saves the whole draft; form and flow tabs each pass the half they changed.
  async function saveDraft(patch: { form?: FormField[], workflow?: Graph }) {
    const base = editable.value
    if (!base) throw new Error('no version to edit')
    const draft = await api<Version>(`/api/jobs/${toValue(id)}/draft`, {
      method: 'PUT',
      body: { form: patch.form ?? base.form, workflow: patch.workflow ?? base.workflow },
    })
    if (detail.value) detail.value = { ...detail.value, draft }
    return draft
  }
  return { detail, error, editable, refresh, saveDraft }
}

// The public apply link for a job.
export const applyUrl = (jobId: string) => (import.meta.client ? location.origin : '') + `/apply/${jobId}`
