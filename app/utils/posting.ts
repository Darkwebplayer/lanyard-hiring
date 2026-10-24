// How a job's facts read to a candidate, the same on /careers and /apply. Numbers use the 'en' locale (the page's lang)
// so the server render and the browser render give the same text and Vue never patches it on hydration.

export const workplaceLabel = (w: string | null) => (w ? ({ on_site: 'On-site', hybrid: 'Hybrid', remote: 'Remote' } as Record<string, string>)[w] ?? null : null)

// "full_time" → "Full time"; free text stays as typed, first letter up
export const typeLabel = (t: string | null) => (t ? t.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : null)

export function salaryText(s: { min: number | null, max: number | null, currency: string | null } | null) {
  if (!s || (s.min === null && s.max === null)) return null
  // whole amounts read as "£28,000"; hourly pay keeps its pence on both ends ("£12.60 – £13.50"), never rounded up
  const d = [s.min, s.max].some(v => v !== null && !Number.isInteger(v)) ? 2 : 0
  const nf = new Intl.NumberFormat('en', { ...(s.currency && { style: 'currency', currency: s.currency }), minimumFractionDigits: d, maximumFractionDigits: d })
  if (s.min !== null && s.max !== null) return `${nf.format(s.min)} – ${nf.format(s.max)}`
  return s.min !== null ? `From ${nf.format(s.min)}` : `Up to ${nf.format(s.max!)}`
}

// One name per source tag (?src=…), the same on board cards, the list, the candidate page and Hires.
// Unknown tags are someone's own share-menu slug: shown as typed, read as words.
const SOURCES: Record<string, string> = {
  linkedin: 'LinkedIn', indeed: 'Indeed', google: 'Google', feed: 'Job feed', careers: 'Careers page', 'careers-page': 'Careers page',
  referral: 'Referral', import: 'Imported from a spreadsheet',
}
export const sourceLabel = (s: string | null | undefined, none = 'Unknown') =>
  !s ? none : SOURCES[s.toLowerCase()] ?? s.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase())
