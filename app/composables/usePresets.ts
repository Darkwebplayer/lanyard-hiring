import type { Preset } from '~/lib/flow'

// The company's step presets: shared by the step library and the canvas palette, so an edit shows in both.
export const usePresets = () => {
  const presets = useState<Preset[] | null>('presets', () => null)
  const error = useState<ApiError | null>('presets-error', () => null)
  async function refresh() {
    try {
      presets.value = await api<Preset[]>('/api/step-presets')
      error.value = null
    }
    catch (e) {
      error.value = e as ApiError
    }
  }
  const replace = (p: Preset) => { if (presets.value) presets.value = presets.value.map(x => (x.id === p.id ? p : x)) }

  async function create(input: { type: string, label: string, description?: string, config: unknown, inPalette?: boolean }) {
    const p = await api<Preset>('/api/step-presets', { method: 'POST', body: input })
    presets.value = [...(presets.value ?? []), p]
    return p
  }
  async function update(id: string, patch: Partial<Pick<Preset, 'label' | 'description' | 'config' | 'inPalette'>>) {
    const p = await api<Preset>(`/api/step-presets/${id}`, { method: 'PATCH', body: patch })
    replace(p)
    return p
  }
  async function remove(id: string) {
    await api(`/api/step-presets/${id}`, { method: 'DELETE' })
    presets.value = (presets.value ?? []).filter(p => p.id !== id)
  }
  // Optimistic: the new order shows at once and rolls back if the server refuses it.
  async function reorder(section: string, ids: string[]) {
    const before = presets.value
    presets.value = (presets.value ?? []).map(p => (ids.includes(p.id) ? { ...p, position: ids.indexOf(p.id) } : p))
    try {
      const rows = await api<Preset[]>('/api/step-presets/order', { method: 'PUT', body: { section, ids } })
      rows.forEach(replace)
    }
    catch (e) {
      presets.value = before
      if ((e as ApiError).code === 'section_changed') await refresh()
      throw e
    }
  }
  return { presets, error, refresh, create, update, remove, reorder }
}
