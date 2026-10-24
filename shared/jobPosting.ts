import { renderMarkdown } from '../app/utils/markdown'

// What a public job carries (GET /api/public/jobs and /api/public/jobs/:id both fit).
export interface PostingJob {
  id: string
  title: string
  description: string | null // Markdown
  postedAt: string | Date | null
  closesAt: string | Date | null
  employmentType: string | null // free text, e.g. "Full-time"
  workplaceType: 'on_site' | 'hybrid' | 'remote' | null
  location: string | null // free text, e.g. "Berlin, Germany"
  salary: { min: number | null, max: number | null, currency: string | null } | null
}

// "Full-time" / "full_time" / "Fulltime" → "fulltime" (Indeed's jobtype words), or null when it isn't one we know
export function jobType(t: string | null) {
  const k = (t ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return ({ fulltime: 'fulltime', parttime: 'parttime', contract: 'contract', contractor: 'contract', freelance: 'contract', internship: 'internship', intern: 'internship', temporary: 'temporary', temp: 'temporary' } as const)[k] ?? null
}
const GOOGLE_TYPE = { fulltime: 'FULL_TIME', parttime: 'PART_TIME', contract: 'CONTRACTOR', internship: 'INTERN', temporary: 'TEMPORARY' } as const

// "Berlin, Germany" → city Berlin, country Germany; one part is a city. "Remote" alone is no place.
// ponytail: comma split, no geocoding; a structured location field would make this exact
export function splitLocation(location: string | null) {
  const parts = (location ?? '').replace(/\bremote\b/gi, '').split(',').map(p => p.replace(/^[\s()/-]+|[\s()/-]+$/g, '')).filter(Boolean)
  return { city: parts[0] ?? null, country: parts.length > 1 ? parts.at(-1)! : null }
}

const iso = (d: string | Date | null) => (d ? new Date(d).toISOString() : undefined)

// schema.org JobPosting for Google job search. Put it in a <script type="application/ld+json"> on the apply page.
export function jobPostingLd(job: PostingJob, company: string | null, url: string) {
  const type = jobType(job.employmentType)
  const place = splitLocation(job.location)
  const s = job.salary
  return {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description: renderMarkdown(job.description ?? '') || job.title, // Google wants HTML and a non-empty description
    datePosted: iso(job.postedAt),
    validThrough: iso(job.closesAt),
    employmentType: type ? GOOGLE_TYPE[type] : undefined,
    hiringOrganization: { '@type': 'Organization', name: company ?? undefined },
    url,
    directApply: true,
    ...(job.workplaceType === 'remote'
      ? {
          jobLocationType: 'TELECOMMUTE',
          applicantLocationRequirements: place.city ? { '@type': 'Country', name: place.country ?? place.city } : undefined,
        }
      : {
          jobLocation: place.city
            ? { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: place.city, addressCountry: place.country ?? undefined } }
            : undefined,
        }),
    // Google needs a currency; the period isn't stored, so a yearly salary is assumed
    // ponytail: unitText YEAR is a guess; add salary_period to requirements when hourly or monthly jobs show up
    baseSalary: s?.currency
      ? { '@type': 'MonetaryAmount', currency: s.currency, value: { '@type': 'QuantitativeValue', minValue: s.min ?? undefined, maxValue: s.max ?? undefined, unitText: 'YEAR' } }
      : undefined,
  }
}
