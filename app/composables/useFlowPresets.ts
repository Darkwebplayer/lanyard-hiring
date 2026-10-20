import type { FormField, Graph } from '~~/shared/workflow/types'

export interface FlowPreset { id: string, name: string, description: string, form: FormField[], workflow: Graph, createdAt: string }

// The company's flow presets: shared by the library, the New job dialog and the Flow tab's menu.
export const useFlowPresets = () => {
  const flowPresets = useState<FlowPreset[] | null>('flow-presets', () => null)
  const error = useState<ApiError | null>('flow-presets-error', () => null)
  const byName = (list: FlowPreset[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))
  async function refresh() {
    try {
      flowPresets.value = await api<FlowPreset[]>('/api/flow-presets')
      error.value = null
    }
    catch (e) {
      error.value = e as ApiError
    }
  }
  async function create(input: { name: string, description?: string, form: FormField[], workflow: Graph }) {
    const p = await api<FlowPreset>('/api/flow-presets', { method: 'POST', body: input })
    flowPresets.value = byName([...(flowPresets.value ?? []), p])
    return p
  }
  // A rename, or a whole new form and flow (never one half)
  async function update(id: string, patch: { name?: string, description?: string } | { name?: string, description?: string, form: FormField[], workflow: Graph }) {
    const p = await api<FlowPreset>(`/api/flow-presets/${id}`, { method: 'PATCH', body: patch })
    if (flowPresets.value) flowPresets.value = byName(flowPresets.value.map(x => (x.id === p.id ? p : x)))
    return p
  }
  async function remove(id: string) {
    await api(`/api/flow-presets/${id}`, { method: 'DELETE' })
    flowPresets.value = (flowPresets.value ?? []).filter(p => p.id !== id)
  }
  return { flowPresets, error, refresh, create, update, remove }
}
