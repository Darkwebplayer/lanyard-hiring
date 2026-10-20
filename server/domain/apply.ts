import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { answersSchema, coreSchema, FILE_MIMES, type FileMeta, MAX_FILE_BYTES } from '../../shared/workflow/form'
import type { FormField, Issue } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applications, candidates, jobs, jobVersions, settings } from '../db/schema'
import { sha256Hex, sniffCv } from '../engine/handlers/extract'
import { DomainError, pgCode } from './errors'

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

// Public job page: only what an applicant should see.
export async function publicJob(db: Db, jobId: string, now: Date) {
  const { job, version } = await openJob(db, jobId, now)
  const [s] = await db.select().from(settings)
  const req = version.requirements as Record<string, unknown>
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    companyName: s?.companyName ?? null,
    // candidates reach the team by replying, so the reply-to address is already theirs to see
    contactEmail: s?.replyToEmail ?? null,
    location: req.location ?? null,
    employmentType: req.employment_type ?? null,
    minExperienceYears: req.min_experience_years ?? null,
    mustHaveSkills: req.must_have_skills ?? [],
    closesAt: job.closesAt,
    form: (version.form as FormField[]).map(({ key, label, type, required, min, max, options }) => ({ key, label, type, required, min, max, options })),
    consentText: s?.consentText ?? null,
    aiNoticeText: s?.aiNoticeText ?? null,
  }
}

export interface Submission {
  fields: Record<string, string | string[]> // core fields and non-file answers, as posted
  files: Record<string, { bytes: Uint8Array, name: string }>
}

const issue = (field: string, message: string): Issue => ({ code: 'invalid_field', message: `${field}: ${message}` })

// Validates everything before writing anything; then files to R2, then one transaction.
// Returns the new application id; the caller starts the workflow.
export async function submitApplication(db: Db, bucket: Bucket, jobId: string, sub: Submission, now: Date) {
  const { job, version } = await openJob(db, jobId, now)
  const form = version.form as FormField[]
  const applicationId = crypto.randomUUID()

  const issues: Issue[] = []
  const core = coreSchema.safeParse(sub.fields)
  if (!core.success) issues.push(...core.error.issues.map(i => issue(i.path.join('.'), i.message)))

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
        id: applicationId, jobId: job.id, candidateId: candidate!.id, jobVersionId: version.id, answers: answers.data,
      })
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
