import type { FileMeta } from '../../../shared/workflow/form'
import { MissingRefError, render } from '../../../shared/workflow/template'
import type { Context, FormField } from '../../../shared/workflow/types'
import type { Ai, Criterion, ReviewInput } from '../ai'
import { PROMPT_VERSION } from '../ai'
import type { Email } from '../email'
import { EmailError } from '../email'
import { type AutoHandler, HandlerError } from '../engine'
import { extractCvText, sha256Hex, sniffCv } from './extract'

export interface HandlerDeps {
  bucket: { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> }
  ai: Ai | null
  sendEmail: (idempotencyKey: string, email: Email) => Promise<unknown>
  replyTo: () => Promise<string | null>
}

const MIN_CV_TEXT = 50 // below this the file has no usable text layer (scanned PDF)

const requireAi = (ai: Ai | null) => {
  if (!ai) throw new HandlerError('ai_not_configured', false)
  return ai
}

// Input minimisation: job requirements, non-protected non-file answers by label, and the CV text.
// Never candidate.*, protected fields or files. The input hash is stored as the audit trail.
export function aiReviewInput(ctx: Context, form: FormField[], cvTextRef?: string): ReviewInput {
  const { openings: _, title, ...requirements } = ctx.job
  const answers = form
    .filter(f => !f.protected && f.type !== 'file' && ctx.form[f.key] !== undefined)
    .map(f => ({ label: f.label, value: ctx.form[f.key] }))
  const cv = cvTextRef ? cvTextRef.split('.').reduce<any>((o, k) => o?.[k], ctx) : undefined
  return { job: { title, requirements }, answers, ...(typeof cv === 'string' && cv && { cv_text: cv }) }
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
      const facts = await requireAi(deps.ai).parseCv(text)
      return { output: { text, ...facts, file_sha256: meta.sha256 } }
    },

    ai_review: async ({ config, ctx, form }) => {
      const ai = requireAi(deps.ai)
      const criteria = config.criteria as Criterion[]
      const input = aiReviewInput(ctx, form, config.cv_text_ref)
      const { scores, summary } = await ai.review(input, criteria, config.instructions)
      // overall is the mean of the criteria, not a separate model opinion: explainable and stable
      const overall = Math.round(criteria.reduce((sum, c) => sum + scores[c.key]!, 0) / criteria.length)
      return {
        output: { ...scores, overall, summary },
        input: { model: ai.model, prompt_version: PROMPT_VERSION, input_sha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(input))) },
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
        await deps.sendEmail(run.id, { to: ctx.candidate.email, subject, text, replyTo: (await deps.replyTo()) ?? undefined })
      }
      catch (e) {
        if (e instanceof EmailError) throw new HandlerError('email_failed', e.retryable, e.message)
        throw e
      }
      return { output: { sent: true } }
    },
  }
}
