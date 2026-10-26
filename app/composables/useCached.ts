// A page's data, kept between visits: the last answer shows at once, and every visit (or key change)
// asks the server again and swaps the new answer in. One store, so signing out clears it in one go.
export function useCached<T>(key: MaybeRefOrGetter<string>, get: () => Promise<T>) {
  const store = useState<Record<string, unknown>>('cached', () => ({}))
  const data = computed<T | null>({
    get: () => (store.value[toValue(key)] as T | undefined) ?? null,
    set: (v) => { store.value[toValue(key)] = v },
  })
  const error = ref<ApiError | null>(null)
  async function refresh() {
    const k = toValue(key) // an answer that lands after the key moved on still belongs to its own key
    error.value = null
    try { store.value[k] = await get() }
    catch (e) { error.value = toApiError(e) }
  }
  if (import.meta.client) watch(() => toValue(key), refresh, { immediate: true })
  return { data, error, refresh }
}
