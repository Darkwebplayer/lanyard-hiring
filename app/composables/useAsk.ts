// Ask: a chat about what is on screen. The browser says where you are; the server decides what the AI sees
// (ai_plan.md, "Ask contract"). No saved chats: the thread lives here and survives navigation until the tab closes.
export interface AskCite { label: string, id: string }
export type AskTurn =
  | { role: 'user', text: string }
  | { role: 'assistant', text: string, done: boolean }
  | { role: 'divider', text: string }
export interface AskContext { label: string, initials?: string, scope: 'all' | 'task', placeholder: string, suggestions: string[] }

export const ASK_MAX = 1000
const CITE = /\[([^\]\n]+)\]\(#((?:node|stage|field):[^)\s]+)\)/g

// "[AI review](#node:ai)" → the label stays in the text; the anchor becomes a chip under the answer.
export function parseAnswer(text: string, streaming = false): { paras: string[], cites: AskCite[] } {
  // a citation still arriving would flash as raw markup: hold it back until its ")" comes
  const t = streaming ? text.replace(/\[[^\]\n]*(\]\(#?[^)\s]*)?$/, '') : text
  const cites = new Map<string, AskCite>()
  const plain = t.replace(CITE, (_, label: string, id: string) => {
    if (!cites.has(id)) cites.set(id, { label, id })
    return label
  })
  // models sometimes write the name and then its citation: "Manual review Manual review stage"
  let tidy = plain
  for (const c of cites.values()) tidy = tidy.replaceAll(`${c.label} ${c.label}`, c.label)
  return { paras: tidy.split(/\n{2,}/).map(p => p.trim()).filter(Boolean), cites: [...cites.values()] }
}

// one in flight at a time; client only, so module scope is safe
let ctrl: AbortController | null = null
let ctxKey = ''
let ctxLoad: Promise<void> | null = null
let ctxPage = '' // the divider marks a new page, not a new focus on the same page

export const useAsk = () => {
  const open = useState('ask-open', () => false)
  const thread = useState<AskTurn[]>('ask-thread', () => [])
  const streaming = useState('ask-streaming', () => false)
  const error = useState<string | null>('ask-error', () => null)
  const draft = useState('ask-draft', () => '')
  const focus = useState<string | null>('ask-focus', () => null)
  const ctx = useState<AskContext | null>('ask-ctx', () => null)
  const ctxLoading = useState('ask-ctx-loading', () => false)
  const router = useRouter()
  const { me } = useMe()

  const where = () => {
    const r = router.currentRoute.value
    const params = Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : String(v)]))
    return { route: String(r.name ?? ''), params }
  }

  // GET /api/ask/context, once per page and focus. A new label under a running thread gets a divider.
  function loadContext(): Promise<void> {
    if (me.value?.ai !== 'on') return Promise.resolve()
    const w = where()
    const key = JSON.stringify([w, focus.value])
    if (key === ctxKey && ctxLoad) return ctxLoad
    ctxKey = key
    ctxLoading.value = true
    ctxLoad = api<AskContext>('/api/ask/context', { query: { route: w.route, params: JSON.stringify(w.params), focus: focus.value ?? undefined } })
      .catch(() => null)
      .then((c) => {
        if (key !== ctxKey) return
        ctxLoading.value = false
        const before = ctx.value?.label
        ctx.value = c
        const label = c?.label
        const page = JSON.stringify(w)
        const moved = ctxPage !== '' && page !== ctxPage
        ctxPage = page
        if (!moved || !label || !before || label === before || !thread.value.length || streaming.value) return
        const last = thread.value.at(-1)!
        if (last.role === 'divider') thread.value.pop()
        thread.value.push({ role: 'divider', text: `Now looking at ${label}` })
      })
    return ctxLoad
  }

  async function ask(question: string, at?: string) {
    const q = question.trim().slice(0, ASK_MAX)
    if (!q || streaming.value) return
    open.value = true
    if (at !== undefined && at !== focus.value) focus.value = at
    // the question shows at once; the label loads alongside, since the server builds its own context anyway
    void loadContext()
    // a failed question stays in the box, not in the thread twice
    if (error.value && thread.value.at(-1)?.role === 'user') thread.value.pop()
    error.value = null
    const history = thread.value
      .filter((t): t is Exclude<AskTurn, { role: 'divider' }> => t.role !== 'divider' && !!t.text)
      .slice(-10).map(t => ({ role: t.role, text: t.text.slice(0, 4000) }))
    thread.value.push({ role: 'user', text: q })
    draft.value = ''
    thread.value.push({ role: 'assistant', text: '', done: false })
    const a = thread.value.at(-1) as Extract<AskTurn, { role: 'assistant' }>
    streaming.value = true
    ctrl = new AbortController()
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...where(), focus: focus.value ?? undefined, question: q, history }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        if (res.status === 401) await navigateTo({ path: '/login', query: { next: location.pathname + location.search } })
        throw toApiError({ statusCode: res.status, data: await res.json().catch(() => ({})) })
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        a.text += dec.decode(value, { stream: true })
      }
      a.text += dec.decode()
      if (!a.text.trim()) throw new Error('empty')
      a.done = true
    }
    catch (e) {
      if (ctrl?.signal.aborted) {
        // Stop keeps what came; an answer with nothing in it leaves no trace
        if (a.text.trim()) a.done = true
        else thread.value.splice(thread.value.indexOf(a), 1)
      }
      else {
        thread.value.splice(thread.value.indexOf(a), 1)
        const err = e as Partial<ApiError>
        error.value = err.status ? err.message! : 'The answer stopped. The AI service did not reply.'
        draft.value = q
      }
    }
    finally {
      streaming.value = false
      ctrl = null
    }
  }

  const stop = () => ctrl?.abort()
  const retry = () => ask(draft.value)
  // the flow editor has its own side panel, so Ask lies over it instead of taking a column from the canvas
  const floats = computed(() => ['jobs-id-flow', 'library-flows-id'].includes(String(router.currentRoute.value.name)))
  const lastQuestion = computed(() => thread.value.findLast(t => t.role === 'user')?.text ?? null)

  return { open, thread, streaming, error, draft, focus, ctx, ctxLoading, ask, stop, retry, loadContext, lastQuestion, floats }
}
