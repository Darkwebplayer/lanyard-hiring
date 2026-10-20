const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b) - startOfDay(a)) / DAY)

const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

// "20 Oct", or "20 Oct 2025" outside this year
export function fmtDate(iso: string | Date | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  return (d.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear).format(d)
}

export function fmtDateTime(iso: string | Date | null | undefined) {
  if (!iso) return ''
  return `${fmtDate(iso)}, ${time.format(new Date(iso))}`
}

// Due dates as people say them: "Due today", "Due Thu", "2 days late"
export function fmtDue(iso: string | null | undefined, now = new Date()) {
  if (!iso) return { text: 'No due date', late: false, soon: false }
  const d = new Date(iso)
  const days = daysBetween(now, d)
  if (d.getTime() < now.getTime()) {
    const late = Math.max(daysBetween(d, now), 0)
    return { text: late === 0 ? 'Late today' : late === 1 ? '1 day late' : `${late} days late`, late: true, soon: false }
  }
  if (days === 0) return { text: 'Due today', late: false, soon: true }
  if (days === 1) return { text: 'Due tomorrow', late: false, soon: true }
  if (days < 7) return { text: `Due ${weekday.format(d)}`, late: false, soon: false }
  return { text: `Due ${fmtDate(d)}`, late: false, soon: false }
}

// "just now", "5 min ago", "3 h ago", "Yesterday", then the date
export function fmtAgo(iso: string | Date | null | undefined, now = new Date()) {
  if (!iso) return ''
  const d = new Date(iso)
  const s = (now.getTime() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400 && daysBetween(d, now) === 0) return `${Math.floor(s / 3600)} h ago`
  if (daysBetween(d, now) === 1) return 'Yesterday'
  return fmtDate(d)
}

export const initials = (name: string | null | undefined) =>
  (name ?? '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

export const fullName = (c: { firstName: string, lastName: string }) => `${c.firstName} ${c.lastName}`.trim()

export const pct = (x: number) => `${Math.round(x * 100)}%`

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
