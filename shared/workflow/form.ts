import { z } from 'zod'
import { type Field, type FieldType, type FormField, type Issue, KEY_RE } from './types'

// Always on the form, not configurable. Stored as columns, read as candidate.*
export const CORE_FIELDS: Field[] = [
  { path: 'candidate.first_name', type: 'string', label: 'First name' },
  { path: 'candidate.last_name', type: 'string', label: 'Last name' },
  { path: 'candidate.email', type: 'string', label: 'Email' },
  { path: 'candidate.phone', type: 'string', label: 'Phone' },
]

export const coreSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.email().transform(e => e.trim().toLowerCase()),
  phone: z.preprocess(v => v === '' ? undefined : v, z.string().trim().max(40).optional()),
})

export const FILE_MIMES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const
export const MAX_FILE_BYTES = 10 * 1024 * 1024

// What a file answer looks like once the upload is stored.
export const fileMetaSchema = z.object({
  key: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  mime: z.enum(FILE_MIMES),
  name: z.string().max(255),
})
export type FileMeta = z.infer<typeof fileMetaSchema>

const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'enum', 'date', 'file', 'list'] as const satisfies FieldType[]

export const formFieldSchema = z.object({
  key: z.string().regex(KEY_RE, 'snake_case, starts with a letter, max 40'),
  label: z.string().trim().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  protected: z.boolean().optional(),
})
export const formSchemaDef = z.array(formFieldSchema).max(100)

export function validateForm(form: unknown): Issue[] {
  const parsed = formSchemaDef.safeParse(form)
  if (!parsed.success) {
    return parsed.error.issues.map(i => ({ code: 'invalid_form', message: `form.${i.path.join('.')}: ${i.message}` }))
  }
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const f of parsed.data) {
    if (seen.has(f.key)) issues.push({ code: 'duplicate_field', message: `form field "${f.key}" appears twice` })
    seen.add(f.key)
    if (f.type === 'enum' && !f.options?.length) issues.push({ code: 'enum_without_options', message: `form field "${f.key}" needs options` })
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) issues.push({ code: 'min_gt_max', message: `form field "${f.key}": min > max` })
  }
  return issues
}

export const formFields = (form: FormField[]): Field[] =>
  form.map(f => ({ path: `form.${f.key}`, type: f.type, label: f.label, options: f.options, protected: f.protected }))

// ---------- answers ----------

const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)
const asArray = (v: unknown) => (Array.isArray(v) ? v : [v])

function answerSchema(f: FormField): z.ZodType {
  const len = <T extends z.ZodString | z.ZodArray<any>>(s: T): T => {
    let out: any = s
    if (f.min !== undefined) out = out.min(f.min)
    if (f.max !== undefined) out = out.max(f.max)
    return out
  }
  switch (f.type) {
    case 'string': return len(z.string().trim().max(f.max ?? 500))
    case 'text': return len(z.string().trim().max(f.max ?? 10_000))
    case 'number': {
      // decimal strings only: z.coerce would accept '0x10' and true
      let n = z.preprocess(v => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v, z.number().refine(Number.isFinite, 'not a number'))
      if (f.min !== undefined) n = n.refine(v => v >= f.min!, `min ${f.min}`)
      if (f.max !== undefined) n = n.refine(v => v <= f.max!, `max ${f.max}`)
      return n
    }
    case 'boolean': return z.preprocess(v => v === 'true' || v === 'on' || v === '1' ? true : v === 'false' || v === '0' ? false : v, z.boolean())
    case 'enum': return z.enum(f.options as [string, ...string[]])
    case 'date': return z.iso.date()
    case 'list': {
      // blank items are dropped first, so a required list of only blanks fails
      const items = len(z.array(z.string().max(200)).max(f.max ?? 50))
      return z.preprocess(v => asArray(v).map(x => typeof x === 'string' ? x.trim() : x).filter(x => x !== ''), f.required ? items.min(Math.max(1, f.min ?? 1)) : items)
    }
    case 'file': return fileMetaSchema
  }
}

// Zod schema for one application's answers, generated from the pinned form. Empty counts as absent.
export function answersSchema(form: FormField[]) {
  return z.object(Object.fromEntries(form.map((f) => {
    const s = z.preprocess(v => empty(v) ? undefined : v, f.required ? answerSchema(f) : answerSchema(f).optional())
    return [f.key, s]
  }))).strip()
}
