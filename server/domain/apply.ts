import { and, desc, eq, gt, isNull, min, or, sql } from 'drizzle-orm'
import { renderMarkdown } from '../../app/utils/markdown'
import { jobType, splitLocation } from '../../shared/jobPosting'
import { answersSchema, coreSchema, FILE_MIMES, type FileMeta, MAX_FILE_BYTES } from '../../shared/workflow/form'
import type { Requirements } from '../../shared/workflow/job'
import type { FormField, Issue } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applications, candidates, jobs, jobVersions, settings } from '../db/schema'
import { sha256Hex, sniffCv } from '../engine/handlers/extract'
import { queueEmail, words } from './emails'
import { DomainError, pgCode } from './errors'
import { logoUrl } from './settings'

export interface Bucket {
  put: (key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string }, sha256?: string }) => Promise<unknown>
  delete: (key: string) => Promise<unknown>
}

// A job is open to applicants only when published, open, and before its closing date.
export async function openJob(db: Db, jobId: string, now: Date) {
  const [row] = await db.select({ job: jobs, version: jobVersions }).from(jobs)
    .innerJoin(jobVersions, eq(jobVersions.id, jobs.publishedVersionId))
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'open')))
  if (!row || (row.job.closesAt && row.job.closesAt <= now)) throw new DomainError(404, 'job_not_open')
  return row
}

// internal unless the recruiter opted in for this version
export const publicSalary = (req: Requirements) => req.show_salary && (req.salary_min !== undefined || req.salary_max !== undefined)
  ? { min: req.salary_min ?? null, max: req.salary_max ?? null, currency: req.salary_currency ?? null }
  : null

// Every job taking applications, newest first, for /careers and the job feed. Only public fields.
export async function openJobs(db: Db, now: Date) {
  const rows = await db.select({
    id: jobs.id, title: jobs.title, description: jobs.description, closesAt: jobs.closesAt, requirements: jobVersions.requirements,
    // "posted": the first publish, not the latest re-publish
    postedAt: sql<string | null>`(select min(v.published_at) from ${jobVersions} v where v.job_id = ${jobs.id})`.mapWith(v => v === null ? null : new Date(v)),
  }).from(jobs)
    .innerJoin(jobVersions, eq(jobVersions.id, jobs.publishedVersionId))
    .where(and(eq(jobs.status, 'open'), or(isNull(jobs.closesAt), gt(jobs.closesAt, now))))
    .orderBy(desc(jobs.createdAt))
  const [s] = await db.select().from(settings)
  return {
    company: { name: s?.companyName ?? null, careersIntro: s?.careersIntro ?? null, logoUrl: logoUrl(s?.logoKey) },
    jobs: rows.map(({ requirements, ...j }) => {
      const req = requirements as Requirements
      return {
        ...j,
        location: req.location ?? null,
        workplaceType: req.workplace_type ?? null,
        employmentType: req.employment_type ?? null,
        salary: publicSalary(req),
      }
    }),
  }
}

// Every text in CDATA: only "]]>" needs splitting, and characters XML forbids are dropped.
// eslint-disable-next-line no-control-regex
const cdata = (v: string | null | undefined) => `<![CDATA[${(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

// The open jobs as one Indeed-style XML feed (job boards and aggregators read this format). Links carry ?src=feed.
export function jobsFeedXml(origin: string, { company, jobs: list }: Awaited<ReturnType<typeof openJobs>>, now: Date) {
  const tag = (name: string, v: string | null | undefined) => `<${name}>${cdata(v)}</${name}>`
  const jobsXml = list.map((j) => {
    const place = splitLocation(j.location)
    const s = j.salary
    const salary = s && [s.min, s.max].filter(n => n !== null).join('-') + (s.currency ? ` ${s.currency}` : '')
    return ['<job>', tag('title', j.title), tag('date', (j.postedAt ?? now).toUTCString()), tag('referencenumber', j.id),
      tag('url', `${origin}/apply/${j.id}?src=feed`), tag('company', company.name), tag('city', place.city), tag('country', place.country),
      tag('description', renderMarkdown(j.description) || j.title), tag('salary', salary), tag('jobtype', jobType(j.employmentType)),
      j.workplaceType === 'remote' ? tag('remotetype', 'Fully remote') : '', '</job>'].join('')
  })
  return `<?xml version="1.0" encoding="utf-8"?>\n<source>${tag('publisher', company.name)}${tag('publisherurl', origin)}${tag('lastBuildDate', now.toUTCString())}\n${jobsXml.join('\n')}\n</source>\n`
}

// Public job page: only what an applicant should see.
export async function publicJob(db: Db, jobId: string, now: Date) {
  const { job, version } = await openJob(db, jobId, now)
  const [s] = await db.select().from(settings)
  // "posted": the first publish, not the latest re-publish
  const [{ postedAt } = { postedAt: null }] = await db.select({ postedAt: min(jobVersions.publishedAt) }).from(jobVersions).where(eq(jobVersions.jobId, jobId))
  const req = version.requirements as Requirements
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    companyName: s?.companyName ?? null,
    logoUrl: logoUrl(s?.logoKey),
    // candidates reach the team by replying, so the reply-to address is already theirs to see
    contactEmail: s?.replyToEmail ?? null,
    location: req.location ?? null,
    employmentType: req.employment_type ?? null,
    workplaceType: req.workplace_type ?? null,
    openings: job.openings,
    postedAt,
    salary: publicSalary(req),
    minExperienceYears: req.min_experience_years ?? null,
    mustHaveSkills: req.must_have_skills ?? [],
    closesAt: job.closesAt,
    form: (version.form as FormField[]).map(({ key, label, type, required, min, max, options }) => ({ key, label, type, required, min, max, options })),
    consentText: s?.consentText ?? null,
    aiNoticeText: s?.aiNoticeText ?? null,
  }
}

export interface Submission {
  fields: Record<string, string | string[]> // core fields, non-file answers, `source` and `consent`, as posted
  files: Record<string, { bytes: Uint8Array, name: string }>
}

const issue = (field: string, message: string): Issue => ({ code: 'invalid_field', message: `${field}: ${message}` })

// Validates everything before writing anything; then files to R2, then one transaction.
// Returns the new application id; the caller starts the workflow and delivers the "we got it" email.
export async function submitApplication(db: Db, bucket: Bucket, jobId: string, sub: Submission, now: Date, appUrl = '') {
  const { job, version } = await openJob(db, jobId, now)
  const form = version.form as FormField[]
  const applicationId = crypto.randomUUID()

  const issues: Issue[] = []
  const core = coreSchema.safeParse(sub.fields)
  if (!core.success) issues.push(...core.error.issues.map(i => issue(i.path.join('.'), i.message)))
  // where they came from (?src / utm_source): free text from the URL, so trimmed, lowercased and capped
  const tag = String(sub.fields.source ?? '').trim().toLowerCase().slice(0, 40)
  // 'import' is reserved for spreadsheet imports (the engine and the hires report read it)
  const source = tag && tag !== 'import' ? tag : null
  // the apply page shows the consent checkbox only when Settings has a text, so that text is what they agreed to
  // ponytail: the text is read at submit, not at page load; an edit in between stores the newer text
  const [s] = await db.select({ consentText: settings.consentText }).from(settings)
  const consent = s?.consentText ? { text: s.consentText, at: now.toISOString() } : null
  if (consent && !['true', 'on'].includes(String(sub.fields.consent))) issues.push(issue('consent', 'Required'))

  // files: real type by magic bytes, size, hash — computed now, uploaded only if everything is valid
  const uploads: { field: string, bytes: Uint8Array, meta: FileMeta }[] = []
  for (const f of form.filter(f => f.type === 'file')) {
    const file = sub.files[f.key]
    if (!file || !file.bytes.length) continue // required-ness is checked by answersSchema below
    if (file.bytes.length > MAX_FILE_BYTES) {
      issues.push(issue(f.key, 'file is larger than 10 MB'))
      continue
    }
    const mime = sniffCv(file.bytes)
    if (!mime || !(FILE_MIMES as readonly string[]).includes(mime)) {
      issues.push(issue(f.key, 'only PDF or DOCX files are accepted'))
      continue
    }
    // write-once key: never reused, never overwritten
    const key = `jobs/${job.id}/${applicationId}/${crypto.randomUUID()}`
    const meta: FileMeta = { key, sha256: await sha256Hex(file.bytes as Uint8Array<ArrayBuffer>), size: file.bytes.length, mime, name: file.name.slice(0, 255) }
    uploads.push({ field: f.key, bytes: file.bytes, meta })
  }

  const raw: Record<string, unknown> = {}
  for (const f of form) raw[f.key] = f.type === 'file' ? uploads.find(u => u.field === f.key)?.meta : sub.fields[f.key]
  const answers = answersSchema(form).safeParse(raw)
  // a file we already refused would also read as "required"; report it once
  const refused = new Set(issues.map(i => i.message.split(':')[0]))
  if (!answers.success) issues.push(...answers.error.issues.filter(i => !refused.has(String(i.path[0]))).map(i => issue(i.path.join('.'), i.message)))
  if (issues.length) throw new DomainError(422, 'invalid_application', issues)

  try {
    await Promise.all(uploads.map(u => bucket.put(u.meta.key, u.bytes, { httpMetadata: { contentType: u.meta.mime }, sha256: u.meta.sha256 })))
    await db.transaction(async (tx) => {
      // the job may have closed while the files uploaded; this read also blocks a concurrent close until commit
      const [still] = await tx.select({ id: jobs.id }).from(jobs)
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'open'), or(isNull(jobs.closesAt), gt(jobs.closesAt, now)))).for('share')
      if (!still) throw new DomainError(404, 'job_not_open')
      const c = core.data!
      // One candidate per email. Existing details are never overwritten: emails aren't verified, so
      // anyone could otherwise rename someone else's candidate record by applying with their address.
      const [candidate] = await tx.insert(candidates)
        .values({ email: c.email, firstName: c.first_name, lastName: c.last_name, phone: c.phone ?? null })
        .onConflictDoUpdate({ target: candidates.email, set: { email: sql`excluded.email` } })
        .returning()
      await tx.insert(applications).values({
        id: applicationId, jobId: job.id, candidateId: candidate!.id, jobVersionId: version.id, answers: answers.data, source, consent,
      })
      // the status link goes only to the inbox: the address isn't verified, so it is never shown on screen
      const [s] = await tx.select({ companyName: settings.companyName }).from(settings)
      await queueEmail(tx, { applicationId, kind: 'received', key: `received:${applicationId}`, ...words.received({ first: candidate!.firstName, job: job.title, company: s?.companyName ?? null }) }, appUrl)
    })
  }
  catch (e) {
    // best effort (also covers a partly failed upload): orphans are harmless, but don't keep files for an application that doesn't exist
    await Promise.allSettled(uploads.map(u => bucket.delete(u.meta.key)))
    if (pgCode(e) === '23505') throw new DomainError(409, 'already_applied')
    throw e
  }
  return applicationId
}
