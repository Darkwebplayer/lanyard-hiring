import type { FileMeta } from '../../../shared/workflow/form'
import { MissingRefError, render } from '../../../shared/workflow/template'
import type { Context, FormField } from '../../../shared/workflow/types'
import type { Ai, CheckQuestion, Criterion, ReviewInput } from '../ai'
import { checkRequest, PROMPT_VERSION, reviewRequest } from '../ai'
import type { Email } from '../email'
import { EmailError } from '../email'
import { type AutoHandler, HandlerError } from '../engine'
import { extractCvText, sha256Hex, sniffCv } from './extract'
import { documentsEmail } from '../../domain/documents'

export interface HandlerDeps {
  bucket: { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> }
  ai: Ai | null
  // a candidate email: logged on their page (candidate_emails) and sent; `log` says whose and what kind
  sendEmail: (idempotencyKey: string, email: Email, log: { applicationId: string, kind: string }) => Promise<unknown>
  replyTo: () => Promise<string | null>
  aiEnabled?: () => Promise<boolean> // the admin's switch in Settings; left out = on
  appUrl?: string // for links in emails (request_documents)
}

const MIN_CV_TEXT = 50 // below this the file has no usable text layer (scanned PDF)

const hashJson = (v: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(v)))

const requireAi = async (deps: HandlerDeps) => {
  if (!deps.ai) throw new HandlerError('ai_not_configured', false)
  if (deps.aiEnabled && !(await deps.aiEnabled())) throw new HandlerError('ai_off', false)
  return deps.ai
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g

// CVs open with the candidate's name, email and phone; the AI needs none of them.
// ponytail: exact-match and pattern redaction; addresses and photos' alt text still get through.
export function redactIdentity(text: string, c: Context['candidate']) {
  let out = text.replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, m => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m)) // year ranges have 8 digits
  for (const v of [c.email, c.phone, c.first_name, c.last_name]) {
    if (v && v.trim().length >= 2) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v.trim())}(?![\\p{L}\\p{N}])`, 'giu'), '[redacted]')
  }
  return out
}

// Clairic's list answers sometimes come back as sub-word pieces ("Man", "hattan WMS", "WS") or with a trailing comma,
// though the PDF text is whole. Trim punctuation, rejoin neighbours that make a whole word of the CV, and drop
// short pieces (3 letters or fewer) the CV only has inside a longer word. Longer items are kept even when only a
// stem matches ("Forklift" in "forklifts"), and so are paraphrases the CV doesn't contain at all.
export function cleanList(items: unknown[], text: string) {
  const flat = text.replace(/\s+/g, ' ') // PDF line breaks split "Manhattan\nWMS"
  const whole = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'iu').test(flat)
  const piece = (s: string) => s.length <= 3 && !whole(s) && flat.toLowerCase().includes(s.toLowerCase())
  const list = items.filter((i): i is string => typeof i === 'string')
    .map(i => i.trim().replace(/^[\s•·*,;:-]+|[\s•·*,;:.]+$/g, '')).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    const [a, b] = [list[i]!, list[i + 1]]
    if (b && !(whole(a) && whole(b)) && whole(a + b)) out.push(a + b), i++
    else if (!piece(a)) out.push(a)
  }
  return [...new Map(out.map(s => [s.toLowerCase(), s])).values()]
}

// The only refs the AI may read as CV text: a non-protected form text field, or a CV parse output.
// Validation enforces the same; this is the backstop.
function cvTextFrom(ctx: Context, form: FormField[], ref?: string) {
  const [root, key, leaf, ...rest] = ref?.split('.') ?? []
  if (root === 'form' && key && !leaf && form.some(f => f.key === key && !f.protected && f.type !== 'file')) return ctx.form[key]
  if (root === 'nodes' && key && leaf === 'text' && !rest.length) return ctx.nodes[key]?.text
  return undefined
}

const MAX_DESCRIPTION_CHARS = 6000 // a long job ad; the requirements are what the criteria score against

// Input minimisation: the job (title, description, requirements), non-protected non-file answers by label, and the
// CV text with the candidate's identity redacted. Never candidate.*, protected fields or files.
export function aiReviewInput(ctx: Context, form: FormField[], cvTextRef?: string): ReviewInput {
  const { openings: _, title, description, ...requirements } = ctx.job
  const answers = form
    .filter(f => !f.protected && f.type !== 'file' && ctx.form[f.key] !== undefined)
    .map(f => ({ label: f.label, value: ctx.form[f.key] }))
  const cv = cvTextFrom(ctx, form, cvTextRef)
  const about = description?.trim().slice(0, MAX_DESCRIPTION_CHARS)
  return { job: { title, ...(about && { description: about }), requirements }, answers, ...(typeof cv === 'string' && cv && { cv_text: redactIdentity(cv, ctx.candidate) }) }
}

export function createHandlers(deps: HandlerDeps): Record<string, AutoHandler> {
  return {
    cv_parse: async ({ config, ctx }) => {
      const meta = ctx.form[config.file_field] as FileMeta | undefined
      if (!meta?.key) throw new HandlerError('missing_file', false)
      const obj = await deps.bucket.get(meta.key)
      if (!obj) throw new HandlerError('file_not_found', false, meta.key)
      const bytes = new Uint8Array(await obj.arrayBuffer())
      if (await sha256Hex(bytes) !== meta.sha256) throw new HandlerError('checksum_mismatch', false, meta.key)
      const mime = sniffCv(bytes)
      if (!mime) throw new HandlerError('unreadable_cv', false, 'not a pdf or docx')
      // a corrupt file won't parse any better on retry
      const text = await extractCvText(bytes, mime).catch((e: Error) => { throw new HandlerError('unreadable_cv', false, e.message) })
      if (text.replace(/\s/g, '').length < MIN_CV_TEXT) throw new HandlerError('unreadable_cv', false, 'no text layer (scanned?)')
      const facts = await (await requireAi(deps)).parseCv(redactIdentity(text, ctx.candidate), config.extract ?? [])
      for (const k of ['skills', ...(config.extract ?? []).filter((f: { type: string }) => f.type === 'list').map((f: { key: string }) => f.key)]) {
        if (Array.isArray(facts[k])) facts[k] = cleanList(facts[k], text)
      }
      return { output: { text, ...facts, file_sha256: meta.sha256 } }
    },

    ai_review: async ({ config, ctx, form }) => {
      const ai = await requireAi(deps)
      const criteria = config.criteria as Criterion[]
      const input = aiReviewInput(ctx, form, config.cv_text_ref)
      const { scores, sure, summary } = await ai.review(input, criteria, config.instructions)
      // overall is the mean of the criteria, not a separate model opinion: explainable and stable
      const overall = Math.round(criteria.reduce((sum, c) => sum + scores[c.key]!, 0) / criteria.length)
      return {
        output: { ...scores, overall, summary },
        // the hash covers exactly what the model was sent (questions, criteria, instructions, truncated CV)
        input: { model: ai.model, prompt_version: PROMPT_VERSION, input_sha256: await hashJson(reviewRequest(input, criteria, config.instructions)), sure },
      }
    },

    ai_check: async ({ config, ctx, form }) => {
      const ai = await requireAi(deps)
      const questions = config.questions as CheckQuestion[]
      const input = aiReviewInput(ctx, form, config.cv_text_ref)
      const { answers, sure } = await ai.check(input, questions)
      return {
        output: answers,
        input: { model: ai.model, prompt_version: PROMPT_VERSION, input_sha256: await hashJson(checkRequest(input, questions)), sure },
      }
    },

    send_email: async ({ run, config, ctx }) => {
      let subject: string, text: string
      try {
        subject = render(config.subject, ctx, { strict: true })
        text = render(config.body, ctx, { strict: true })
      }
      catch (e) {
        if (e instanceof MissingRefError) throw new HandlerError('missing_ref', false, e.refs.join(', '))
        throw e
      }
      try {
        // run id = idempotency key: a redelivery after a crash never sends twice
        await deps.sendEmail(run.id, { to: ctx.candidate.email, subject, text, replyTo: (await deps.replyTo()) ?? undefined }, { applicationId: run.applicationId, kind: 'flow' })
      }
      catch (e) {
        if (e instanceof EmailError) throw new HandlerError('email_failed', e.retryable, e.message)
        throw e
      }
      return { output: { sent: true } }
    },

    // the candidate's upload link; the run then waits for the documents (see executeAutoRun)
    request_documents: async ({ run, config, ctx }) => {
      const { token } = run.input as { token: string }
      const email = documentsEmail(ctx.candidate.first_name, ctx.job.title, config.documents, `${deps.appUrl ?? ''}/documents/${token}`)
      try {
        await deps.sendEmail(run.id, { to: ctx.candidate.email, ...email, replyTo: (await deps.replyTo()) ?? undefined }, { applicationId: run.applicationId, kind: 'documents' })
      }
      catch (e) {
        if (e instanceof EmailError) throw new HandlerError('email_failed', e.retryable, e.message)
        throw e
      }
      return { output: {} }
    },
  }
}
