export interface Toast { id: number, text: string, action?: { label: string, run: () => void } }

// One toast at a time, queued; never the only home of something the person needs.
export const useToast = () => {
  const queue = useState<Toast[]>('toasts', () => [])
  let seq = 0
  function show(text: string, action?: Toast['action'], ms = 5000) {
    const t = { id: Date.now() + seq++, text, action }
    queue.value = [...queue.value, t]
    setTimeout(() => dismiss(t.id), ms)
  }
  function dismiss(id: number) {
    queue.value = queue.value.filter(t => t.id !== id)
  }
  return { queue, show, dismiss }
}
