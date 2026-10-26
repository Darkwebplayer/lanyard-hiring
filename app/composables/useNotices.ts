// The Updates bell and tray (server/domain/notices.ts). The bell polls a count; the list loads when the tray opens.
export interface Notice { seq: number, at: string, tier: 'urgent' | 'important' | 'fyi', cat: 'problems' | 'candidates' | 'tasks' | 'offers', text: string, to: string, read: boolean }
interface NoticeList { items: Notice[], seenSeq: number, latestSeq: number, unread: number, urgent: number }

const POLL_MS = 60_000

export const useNotices = () => {
  const count = useState('notice-count', () => ({ unread: 0, urgent: 0 }))
  const list = useState<NoticeList | null>('notice-list', () => null)
  const error = useState<ApiError | null>('notice-error', () => null)

  // a failed poll keeps the last count: the bell is a hint, not a page
  const poll = () => api<{ unread: number, urgent: number }>('/api/notices/count').then(c => count.value = c).catch(() => {})

  // every minute while the tab is in view; at once when it comes back
  function start() {
    let timer: ReturnType<typeof setInterval> | undefined
    const run = () => {
      clearInterval(timer)
      if (document.visibilityState !== 'visible') return
      poll()
      timer = setInterval(poll, POLL_MS)
    }
    run()
    document.addEventListener('visibilitychange', run)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', run)
    }
  }

  // opening the tray: load, then everything in it counts as seen
  async function load() {
    try {
      const { timeZone: tz, locale } = Intl.DateTimeFormat().resolvedOptions()
      list.value = await api<NoticeList>('/api/notices', { query: { tz, locale } })
      error.value = null
      count.value = { unread: 0, urgent: 0 }
      if (list.value.latestSeq > list.value.seenSeq) await api('/api/notices', { method: 'PUT', body: { seen: list.value.latestSeq } }).catch(() => {})
    }
    catch (e) {
      error.value = e as ApiError
    }
  }

  function open(n: Notice) {
    n.read = true
    api(`/api/notices/${n.seq}`, { method: 'POST', body: {} }).catch(() => {})
  }
  function dismiss(n: Notice) {
    if (list.value) list.value.items = list.value.items.filter(i => i !== n)
    api(`/api/notices/${n.seq}`, { method: 'POST', body: { dismissed: true } }).catch(() => {})
  }
  async function clear() {
    if (!list.value) return
    const cleared = list.value.latestSeq
    list.value.items = []
    await api('/api/notices', { method: 'PUT', body: { cleared } }).catch(() => {})
  }

  return { count, list, error, start, load, open, dismiss, clear }
}
