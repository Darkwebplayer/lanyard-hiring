// First-run guides: the setup wizard, the tour and the help panel, plus what this person has already seen.
// ponytail: "seen" lives in this browser only (localStorage), so a new device shows the tour again; move to a user column if that annoys.
const seenKey = (k: string) => `lanyard:${useMe().me.value?.id ?? 'anon'}:${k}`

export const useSeen = () => ({
  seen: (k: string) => { try { return localStorage.getItem(seenKey(k)) === '1' } catch { return false } },
  markSeen: (k: string) => { try { localStorage.setItem(seenKey(k), '1') } catch {} },
  reset: (k: string) => { try { localStorage.removeItem(seenKey(k)) } catch {} },
})

// Help and Ask share the right-hand dock; the layout closes one when the other opens
export const useHelp = () => {
  const open = useState('help-open', () => false)
  const topic = useState<string | null>('help-topic', () => null) // null = the topic for the current page
  const show = (t?: string) => { topic.value = t ?? null; open.value = true }
  return { open, topic, show }
}

export const useTour = () => useState('tour-run', () => false)
export const useSetup = () => useState('setup-open', () => false)
// true once the setup wizard has decided (shown, skipped or not needed), so the tour knows it may start
export const useSetupChecked = () => useState('setup-checked', () => false)
