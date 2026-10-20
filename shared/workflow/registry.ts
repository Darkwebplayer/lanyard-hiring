import { z } from 'zod'
import { type ConditionConfig, checkRule, conditionBranchKeys, DEFAULT_BRANCH, MISSING_BRANCH, resolvePath, ruleSchema } from './rules'
import { badTagsIn, refsInTemplate } from './template'
import { type Field, type FieldType, type Issue, KEY_RE } from './types'

// trigger: entry point · instant: runs inside the engine transaction · auto: queued handler
// human: waits for submissions · terminal: closes the application
export type NodeKind = 'trigger' | 'instant' | 'auto' | 'human' | 'terminal'

export interface OutputField { key: string, type: FieldType, label: string }

export interface NodeDef<C = any> {
  type: string
  kind: NodeKind
  label: string
  config: z.ZodType<C>
  outputs: (config: C) => OutputField[]
  // refs and type checks against the fields available upstream of this node
  check?: (config: C, available: Map<string, Field>, node: string) => Issue[]
}

const key = z.string().regex(KEY_RE, 'snake_case, starts with a letter, max 40')

const uniqueKeys = (items: { key: string }[], node: string, what: string, reserved: string[] = []): Issue[] => {
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const { key } of items) {
    if (seen.has(key) || reserved.includes(key)) issues.push({ node, code: 'duplicate_key', message: `${what} "${key}" is duplicated or reserved` })
    seen.add(key)
  }
  return issues
}

const checkRef = (path: string, available: Map<string, Field>, node: string, accepts?: FieldType[]): Issue[] => {
  const f = available.get(path)
  if (!f) return [{ node, code: 'unknown_ref', message: `"${path}" is not available here` }]
  if (accepts && !accepts.includes(f.type)) return [{ node, code: 'type_mismatch', message: `"${path}" is ${f.type}, expected ${accepts.join(' or ')}` }]
  return []
}

const TEMPLATE_TYPES: FieldType[] = ['string', 'text', 'number', 'boolean', 'enum', 'date', 'list'] // not file
const checkTemplates = (tpls: (string | undefined)[], available: Map<string, Field>, node: string) =>
  tpls.flatMap(t => !t
    ? []
    : [
        ...badTagsIn(t).map(tag => ({ node, code: 'bad_tag', message: `${tag} is not a valid field reference` })),
        ...refsInTemplate(t).flatMap(r => checkRef(r, available, node, TEMPLATE_TYPES)),
      ])

// ---------- application_received ----------

const trigger: NodeDef<Record<string, never>> = {
  type: 'application_received',
  kind: 'trigger',
  label: 'Application received',
  config: z.object({}).strict(),
  outputs: () => [], // candidate.* and form.* are always in context
}

// ---------- cv_parse ----------

const cvParse: NodeDef<{ file_field: string }> = {
  type: 'cv_parse',
  kind: 'auto',
  label: 'CV parse',
  config: z.object({ file_field: key }).strict(),
  outputs: () => [
    { key: 'text', type: 'text', label: 'CV text' },
    { key: 'skills', type: 'list', label: 'Skills' },
    { key: 'years_experience', type: 'number', label: 'Years of experience' },
    { key: 'current_title', type: 'string', label: 'Current title' },
    { key: 'file_sha256', type: 'string', label: 'File checksum' },
  ],
  check: (c, available, node) => checkRef(`form.${c.file_field}`, available, node, ['file']),
}

// ---------- ai_review ----------

const AI_RESERVED = ['overall', 'summary']

const aiReview: NodeDef<{
  criteria: { key: string, label: string, description: string }[]
  instructions?: string
  cv_text_ref?: string
}> = {
  type: 'ai_review',
  kind: 'auto',
  label: 'AI review',
  config: z.object({
    criteria: z.array(z.object({ key, label: z.string().trim().min(1).max(100), description: z.string().max(1000) }).strict()).min(1).max(10),
    instructions: z.string().max(4000).optional(),
    cv_text_ref: z.string().optional(),
  }).strict(),
  outputs: c => [
    ...c.criteria.map(cr => ({ key: cr.key, type: 'number' as const, label: `${cr.label} (0–100)` })),
    { key: 'overall', type: 'number', label: 'Overall score (0–100)' },
    { key: 'summary', type: 'text', label: 'AI summary' },
  ],
  check: (c, available, node) => {
    const issues = uniqueKeys(c.criteria, node, 'criterion', AI_RESERVED)
    if (!c.cv_text_ref) return issues
    const ref = checkRef(c.cv_text_ref, available, node, ['text', 'string'])
    const f = available.get(c.cv_text_ref)
    // the AI only ever sees CV text or non-protected form text, never copies made by other nodes
    if (!ref.length && (f!.protected || (f!.nodeType && f!.nodeType !== 'cv_parse'))) {
      ref.push({ node, code: 'ai_input_not_allowed', message: `"${c.cv_text_ref}" cannot be sent to the AI` })
    }
    return [...issues, ...ref]
  },
}

// ---------- set_variable ----------

const SETTABLE = ['string', 'text', 'number', 'boolean', 'enum', 'date', 'list'] as const

type VarSource = { kind: 'literal', value: unknown } | { kind: 'ref', ref: string }
interface SetVariableConfig { fields: { key: string, type: typeof SETTABLE[number], label?: string, source: VarSource }[] }

const literalOk: Record<typeof SETTABLE[number], (v: unknown) => boolean> = {
  string: v => typeof v === 'string',
  text: v => typeof v === 'string',
  enum: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  list: v => Array.isArray(v) && v.every(x => typeof x === 'string'),
}
const textLike: FieldType[] = ['string', 'text', 'enum']

const setVariable: NodeDef<SetVariableConfig> = {
  type: 'set_variable',
  kind: 'instant',
  label: 'Set variable',
  config: z.object({
    fields: z.array(z.object({
      key,
      type: z.enum(SETTABLE),
      label: z.string().max(100).optional(),
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('literal'), value: z.unknown() }).strict(),
        z.object({ kind: z.literal('ref'), ref: z.string().min(1) }).strict(),
      ]),
    }).strict()).min(1).max(30),
  }).strict(),
  outputs: c => c.fields.map(f => ({ key: f.key, type: f.type, label: f.label ?? f.key })),
  check: (c, available, node) => [
    ...uniqueKeys(c.fields, node, 'variable'),
    ...c.fields.flatMap((f): Issue[] => {
      if (f.source.kind === 'literal') {
        return literalOk[f.type](f.source.value) ? [] : [{ node, code: 'bad_value', message: `variable "${f.key}": value is not a ${f.type}` }]
      }
      return checkRef(f.source.ref, available, node, textLike.includes(f.type) ? textLike : [f.type])
    }),
  ],
}

export const runSetVariable = (c: SetVariableConfig, ctx: unknown) =>
  Object.fromEntries(c.fields.map(f => [f.key, f.source.kind === 'literal' ? f.source.value : resolvePath(ctx, f.source.ref)]))

// ---------- condition ----------

const condition: NodeDef<ConditionConfig> = {
  type: 'condition',
  kind: 'instant',
  label: 'Condition',
  config: z.object({
    branches: z.array(z.object({ key, label: z.string().trim().min(1).max(100), rule: ruleSchema }).strict()).min(1).max(20),
    on_missing: z.boolean().default(false),
  }).strict() as z.ZodType<ConditionConfig>,
  outputs: () => [],
  check: (c, available, node) => [
    ...uniqueKeys(c.branches, node, 'branch', [DEFAULT_BRANCH, MISSING_BRANCH]),
    ...c.branches.flatMap(b => checkRule(b.rule, available, node)),
  ],
}

export { conditionBranchKeys }

// ---------- human_task ----------

const SCORE_TYPES = ['number', 'boolean', 'text'] as const

export interface ScorecardField { key: string, label: string, type: typeof SCORE_TYPES[number], required: boolean, min?: number, max?: number }
export interface HumanTaskConfig {
  title: string
  instructions?: string
  assignees: { users: string[], roles: string[], job_owner: boolean }
  scorecard: ScorecardField[]
  min_submissions: number
  due_days?: number
}

const humanTask: NodeDef<HumanTaskConfig> = {
  type: 'human_task',
  kind: 'human',
  label: 'Human task',
  config: z.object({
    title: z.string().trim().min(1).max(200),
    instructions: z.string().max(4000).optional(),
    assignees: z.object({
      users: z.array(z.string().min(1)).default([]),
      roles: z.array(z.uuid()).default([]),
      job_owner: z.boolean().default(false),
    }).strict().refine(a => a.users.length || a.roles.length || a.job_owner, 'pick at least one assignee'),
    scorecard: z.array(z.object({
      key,
      label: z.string().trim().min(1).max(200),
      type: z.enum(SCORE_TYPES),
      required: z.boolean().default(true),
      min: z.number().optional(),
      max: z.number().optional(),
    }).strict()).min(1).max(30),
    min_submissions: z.number().int().min(1).max(20).default(1),
    due_days: z.number().int().min(0).max(90).optional(),
  }).strict() as z.ZodType<HumanTaskConfig>,
  outputs: c => [
    ...c.scorecard.flatMap((f): OutputField[] => f.type === 'boolean'
      ? [{ key: f.key, type: 'boolean', label: `${f.label} (all agreed)` }, { key: `${f.key}_any`, type: 'boolean', label: `${f.label} (anyone)` }]
      : [{ key: f.key, type: f.type, label: f.type === 'number' ? `${f.label} (average)` : f.label }]),
    { key: 'submitted_count', type: 'number', label: 'Submissions' },
  ],
  check: (c, available, node) => [
    // compare generated output keys, so "x_any" can't collide with a boolean "x"
    ...uniqueKeys(humanTask.outputs(c), node, 'scorecard field'),
    ...c.scorecard.filter(f => f.min !== undefined && f.max !== undefined && f.min > f.max)
      .map(f => ({ node, code: 'min_gt_max', message: `scorecard field "${f.key}": min > max` })),
    ...checkTemplates([c.title, c.instructions], available, node),
  ],
}

// Validates one assignee's submission against the scorecard.
export function scorecardSchema(scorecard: ScorecardField[]) {
  return z.object(Object.fromEntries(scorecard.map((f) => {
    let s: z.ZodType = f.type === 'boolean'
      ? z.boolean()
      : f.type === 'text'
        ? z.string().trim().max(10_000)
        : z.number().refine(Number.isFinite).refine(v => f.min === undefined || v >= f.min, `min ${f.min}`).refine(v => f.max === undefined || v <= f.max, `max ${f.max}`)
    if (f.type === 'text' && f.required) s = (s as z.ZodString).min(1)
    return [f.key, f.required ? s : s.optional()]
  }))).strict()
}

// numbers → average · booleans → field (all agreed) + field_any (at least one) · text → joined
export function aggregateScorecard(scorecard: ScorecardField[], submissions: Record<string, unknown>[]) {
  const out: Record<string, unknown> = { submitted_count: submissions.length }
  for (const f of scorecard) {
    const vals = submissions.map(s => s[f.key]).filter(v => v !== undefined && v !== null && v !== '')
    if (!vals.length) continue // stays missing, so conditions take the missing branch
    if (f.type === 'number') out[f.key] = (vals as number[]).reduce((a, b) => a + b, 0) / vals.length
    else if (f.type === 'boolean') {
      out[f.key] = vals.every(v => v === true)
      out[`${f.key}_any`] = vals.some(v => v === true)
    }
    else out[f.key] = (vals as string[]).join('\n\n')
  }
  return out
}

// Palette presets: config entries, not new types.
export const HUMAN_TASK_PRESETS: Record<string, { label: string, config: Omit<HumanTaskConfig, 'assignees'> }> = {
  interview: {
    label: 'Interview',
    config: {
      title: 'Interview {{candidate.first_name}} {{candidate.last_name}}',
      scorecard: [
        { key: 'technical', label: 'Technical skills (1–5)', type: 'number', required: true, min: 1, max: 5 },
        { key: 'communication', label: 'Communication (1–5)', type: 'number', required: true, min: 1, max: 5 },
        { key: 'hire', label: 'Hire?', type: 'boolean', required: true },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
      min_submissions: 1,
      due_days: 5,
    },
  },
  assessment_review: {
    label: 'Technical assessment review',
    config: {
      title: 'Review assessment: {{candidate.first_name}} {{candidate.last_name}}',
      scorecard: [
        { key: 'score', label: 'Score (0–100)', type: 'number', required: true, min: 0, max: 100 },
        { key: 'pass', label: 'Pass?', type: 'boolean', required: true },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
      min_submissions: 1,
      due_days: 3,
    },
  },
  hr_approval: {
    label: 'HR approval',
    config: {
      title: 'Approve offer for {{candidate.first_name}} {{candidate.last_name}}',
      scorecard: [
        { key: 'approved', label: 'Approved?', type: 'boolean', required: true },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
      min_submissions: 1,
      due_days: 2,
    },
  },
}

// ---------- send_email ----------

const sendEmail: NodeDef<{ subject: string, body: string }> = {
  type: 'send_email',
  kind: 'auto',
  label: 'Send email',
  config: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000) }).strict(),
  outputs: () => [{ key: 'sent', type: 'boolean', label: 'Sent' }],
  check: (c, available, node) => checkTemplates([c.subject, c.body], available, node),
}

// ---------- end ----------

export const OUTCOMES = ['hired', 'rejected', 'withdrawn'] as const

const end: NodeDef<{ outcome: typeof OUTCOMES[number] }> = {
  type: 'end',
  kind: 'terminal',
  label: 'End',
  config: z.object({ outcome: z.enum(OUTCOMES) }).strict(),
  outputs: () => [],
}

// Handlers (LLM JSON especially) may return "5" for a number or "a" for a list; store declared types.
export function normalizeOutput(fields: OutputField[], output: Record<string, unknown>) {
  const out = { ...output }
  for (const f of fields) {
    const v = out[f.key]
    if (f.type === 'number' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) out[f.key] = Number(v)
    else if (f.type === 'list' && typeof v === 'string') out[f.key] = v.trim() ? [v.trim()] : []
    else if (f.type === 'boolean' && (v === 'true' || v === 'false')) out[f.key] = v === 'true'
  }
  return out
}

export const REGISTRY: Record<string, NodeDef> = Object.fromEntries(
  [trigger, cvParse, aiReview, setVariable, condition, humanTask, sendEmail, end].map(d => [d.type, d]),
)
