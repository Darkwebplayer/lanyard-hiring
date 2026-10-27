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

// "2:00 pm", in the viewer's zone
export const fmtTime = (iso: string | Date) => time.format(new Date(iso))

export function fmtDateTime(iso: string | Date | null | undefined) {
  if (!iso) return ''
  return `${fmtDate(iso)}, ${time.format(new Date(iso))}`
}

// A booked interview: "Tue 27 Oct, 2:00 pm GMT+8". With the zone, because the candidate picked it in theirs.
const booked = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const bookedLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
export function fmtBooked(iso: string | Date | null | undefined, long = false) {
  return iso ? (long ? bookedLong : booked).format(new Date(iso)) : ''
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

// A ListInput's items as sent: trimmed, blanks dropped.
export const listItems = (v: unknown) => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []

// The list's AI score filter, as presets a person picks without typing numbers.
export const SCORE_BANDS = [
  { value: '', label: 'Any AI score' },
  { value: '70', label: 'AI score 70+', min: 70 },
  { value: '40', label: 'AI score 40–69', min: 40, max: 69.999 },
  { value: '0', label: 'AI score under 40', max: 39.999 },
] as const

// "Priya", "Priya and Ben", "Priya, Ben and Ana"
const and = new Intl.ListFormat('en-GB', { type: 'conjunction' })
export const listJoin = (xs: string[]) => and.format(xs)
