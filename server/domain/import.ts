import { and, eq, inArray, sql } from 'drizzle-orm'
import { answersSchema, coreSchema } from '../../shared/workflow/form'
import type { FormField, Graph } from '../../shared/workflow/types'
import type { Db } from '../db/client'
import { applicationEvents, applications, candidates, jobs, jobVersions } from '../db/schema'
import { DomainError } from './errors'

export const MAX_IMPORT_ROWS = 2000

export interface ImportRow {
  first_name?: unknown
  last_name?: unknown
  email?: unknown
  phone?: unknown
  answers?: Record<string, unknown>
  note?: string
  start?: string
}
export interface ImportSummary { create: number, duplicates: string[], invalid: { row: number, problem: string }[] }

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === ''

// Checks every row and, unless dryRun, creates candidates and applications in one transaction.
// Returns the new application ids; the caller starts each (engine `startApplication` begins at the
// pre-set currentNodeKey, or at the trigger when `start` is null).
// Row numbers are spreadsheet rows: rows[0] is row 2, under the header. Fully blank rows are skipped.
export async function importCandidates(db: Db, jobId: string, rows: ImportRow[], start: string | null, actorId: string, dryRun: boolean) {
  const [row] = await db.select({ version: jobVersions }).from(jobs)
    .innerJoin(jobVersions, eq(jobVersions.id, jobs.publishedVersionId)).where(eq(jobs.id, jobId))
  if (!row) throw new DomainError(404, 'job_not_published')
  const { version } = row
  const nodes = new Set((version.workflow as Graph).nodes.map(n => n.key))
  if (start !== null && !nodes.has(start)) throw new DomainError(422, 'node_not_in_version')

  // Types are checked, required-ness is not: imported people often lack answers the form insists on.
  // File answers can't come from a spreadsheet at all, so a step that reads one (Read CV) fails for them
  // with `missing_file` and waits on the board for the manager to move them on by hand; start them past it.
  const form = version.form as FormField[]
  const files = new Set(form.filter(f => f.type === 'file').map(f => f.key))
  const schema = answersSchema(form.filter(f => !files.has(f.key)).map(f => ({ ...f, required: false })))

  const invalid: ImportSummary['invalid'] = []
  const valid: { row: number, email: string, first: string, last: string, phone: string | null, answers: Record<string, unknown>, note?: string, start: string | null }[] = []
  const seen = new Map<string, number>()
  rows.forEach((r, i) => {
    const n = i + 2
    if ([r.first_name, r.last_name, r.email, r.phone].every(blank) && Object.values(r.answers ?? {}).every(blank)) return
    const core = coreSchema.safeParse({ first_name: r.first_name ?? '', last_name: r.last_name ?? '', email: String(r.email ?? '').trim(), phone: r.phone ?? undefined })
    if (!core.success) return invalid.push({ row: n, problem: core.error.issues.map(e => `${e.path.join('.')}: ${blank((r as any)[e.path[0]!]) ? 'missing' : e.message}`).join('; ') })
    const file = Object.keys(r.answers ?? {}).find(k => files.has(k) && !blank(r.answers![k]))
    if (file) return invalid.push({ row: n, problem: `${file}: files can't be imported` })
    const answers = schema.safeParse(r.answers ?? {})
    if (!answers.success) return invalid.push({ row: n, problem: answers.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ') })
    const at = r.start ?? start
    if (at !== null && !nodes.has(at)) return invalid.push({ row: n, problem: `start: no step "${at}" in this job` })
    const c = core.data
    if (seen.has(c.email)) return invalid.push({ row: n, problem: `email: same as row ${seen.get(c.email)}` })
    seen.set(c.email, n)
    valid.push({ row: n, email: c.email, first: c.first_name, last: c.last_name, phone: c.phone ?? null, answers: answers.data, note: r.note?.trim() || undefined, start: at })
  })

  const already = valid.length
    ? await db.select({ email: candidates.email }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .where(and(eq(applications.jobId, jobId), inArray(candidates.email, valid.map(v => v.email))))
    : []
  const duplicates = already.map(a => a.email)
  const fresh = valid.filter(v => !duplicates.includes(v.email))
  const summary: ImportSummary = { create: fresh.length, duplicates, invalid }
  if (dryRun || !fresh.length) return { ...summary, ids: [] as string[] }

  const ids = await db.transaction(async (tx) => {
    // Same rule as apply: one candidate per email, existing details never overwritten.
    const people = await tx.insert(candidates)
      .values(fresh.map(v => ({ email: v.email, firstName: v.first, lastName: v.last, phone: v.phone })))
      .onConflictDoUpdate({ target: candidates.email, set: { email: sql`excluded.email` } })
      .returning({ id: candidates.id, email: candidates.email })
    const byEmail = new Map(people.map(p => [p.email, p.id]))
    // someone who applied since the duplicate check is skipped, not failed
    const created = await tx.insert(applications).values(fresh.map(v => ({
      jobId, candidateId: byEmail.get(v.email)!, jobVersionId: version.id, answers: v.answers,
      source: 'import', consent: null, currentNodeKey: v.start, // startApplication begins here; null = the trigger
    }))).onConflictDoNothing().returning({ id: applications.id, candidateId: applications.candidateId })
    const byCandidate = new Map(fresh.map(v => [byEmail.get(v.email)!, v]))
    if (created.length) {
      await tx.insert(applicationEvents).values(created.map(a => {
        const v = byCandidate.get(a.candidateId)!
        return { applicationId: a.id, type: 'imported', actorId, data: { node: v.start, ...(v.note ? { note: v.note } : {}) } }
      }))
    }
    return created.map(a => a.id)
  })
  return { ...summary, ids }
}
