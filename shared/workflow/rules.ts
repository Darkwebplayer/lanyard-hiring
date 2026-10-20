import { z } from 'zod'
import type { Field, FieldType, Issue } from './types'

export const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin', 'contains', 'exists', 'is_true', 'is_false'] as const
export type Op = typeof OPS[number]

export interface Comparison { ref: string, op: Op, value?: unknown, valueRef?: string }
export type Rule = { all: Rule[] } | { any: Rule[] } | { not: Rule } | Comparison

export const ruleSchema: z.ZodType<Rule> = z.lazy(() => z.union([
  z.object({ all: z.array(ruleSchema).min(1) }).strict(),
  z.object({ any: z.array(ruleSchema).min(1) }).strict(),
  z.object({ not: ruleSchema }).strict(),
  z.object({ ref: z.string().min(1), op: z.enum(OPS), value: z.unknown().optional(), valueRef: z.string().min(1).optional() }).strict(),
]))

// Operators each field type supports; the variable picker filters by this too.
export const OPS_BY_TYPE: Record<FieldType, readonly Op[]> = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin', 'exists'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'exists'],
  string: ['eq', 'neq', 'in', 'nin', 'contains', 'exists'],
  text: ['contains', 'exists'],
  enum: ['eq', 'neq', 'in', 'nin', 'exists'],
  boolean: ['is_true', 'is_false', 'exists'],
  list: ['contains', 'exists'],
  file: ['exists'],
}

// ---------- runtime ----------

export function resolvePath(ctx: unknown, path: string): unknown {
  let cur: any = ctx
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

export const isMissing = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

// Dates are ISO strings (YYYY-MM-DD…). One parser for evaluation and validation, so they agree.
export function toDate(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

// Operators that test presence or truth and take no value
export const VALUELESS: readonly Op[] = ['exists', 'is_true', 'is_false']

export interface TraceEntry {
  ref: string
  op: Op
  expected: unknown
  actual: unknown
  result: boolean
  missing?: true
}

const norm = (v: unknown) => typeof v === 'string' ? v.trim().toLowerCase() : v
// order: ISO dates as timestamps, everything else as-is (numbers)
const ord = (v: unknown) => toDate(v) ?? v as number

function compare(op: Op, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'exists': return true // only reached when present
    case 'is_true': return actual === true
    case 'is_false': return actual === false
    case 'eq': return norm(actual) === norm(expected) || ord(actual) === ord(expected)
    case 'neq': return !compare('eq', actual, expected)
    case 'gt': return ord(actual) > ord(expected)
    case 'gte': return ord(actual) >= ord(expected)
    case 'lt': return ord(actual) < ord(expected)
    case 'lte': return ord(actual) <= ord(expected)
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false
      const [lo, hi] = expected
      return ord(actual) >= ord(lo) && ord(actual) <= ord(hi)
    }
    case 'in': return Array.isArray(expected) && expected.some(e => compare('eq', actual, e))
    case 'nin': return Array.isArray(expected) && !compare('in', actual, expected)
    case 'contains':
      if (Array.isArray(actual)) return actual.some(a => norm(a) === norm(expected))
      return String(norm(actual)).includes(String(norm(expected)))
  }
}

// Evaluates every comparison (no short-circuit) so the trace explains the whole decision.
// A comparison whose value (or valueRef) is missing is false, and is marked missing.
export function evaluate(rule: Rule, ctx: unknown, trace: TraceEntry[] = []): { result: boolean, trace: TraceEntry[] } {
  let result: boolean
  if ('all' in rule) result = rule.all.map(r => evaluate(r, ctx, trace).result).every(Boolean)
  else if ('any' in rule) result = rule.any.map(r => evaluate(r, ctx, trace).result).some(Boolean)
  else if ('not' in rule) result = !evaluate(rule.not, ctx, trace).result
  else {
    const actual = resolvePath(ctx, rule.ref)
    const valueless = VALUELESS.includes(rule.op)
    const expected = valueless ? undefined : rule.valueRef ? resolvePath(ctx, rule.valueRef) : rule.value
    const missing = isMissing(actual) || (!valueless && rule.valueRef !== undefined && isMissing(expected))
    result = !missing && compare(rule.op, actual, expected)
    trace.push({ ref: rule.ref, op: rule.op, expected, actual, result, ...(missing && { missing: true as const }) })
  }
  return { result, trace }
}

// `dataOnly` skips refs of exists/is_true/is_false: those test presence themselves,
// so a missing value there is an answer, not missing data.
export function refsInRule(rule: Rule, out: string[] = [], dataOnly = false): string[] {
  if ('all' in rule) rule.all.forEach(r => refsInRule(r, out, dataOnly))
  else if ('any' in rule) rule.any.forEach(r => refsInRule(r, out, dataOnly))
  else if ('not' in rule) refsInRule(rule.not, out, dataOnly)
  else if (!(dataOnly && VALUELESS.includes(rule.op))) {
    out.push(rule.ref)
    if (rule.valueRef && !VALUELESS.includes(rule.op)) out.push(rule.valueRef)
  }
  return out
}

// ---------- validation ----------

const textLike = new Set<FieldType>(['string', 'text', 'enum'])
const compatible = (a: FieldType, b: FieldType) => a === b || (textLike.has(a) && textLike.has(b))

function valueOk(type: FieldType, v: unknown) {
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v)
  if (type === 'date') return toDate(v) !== undefined
  return typeof v === 'string' && v.length > 0
}

// Checks refs resolve to upstream fields and that operators and values fit their types.
export function checkRule(rule: Rule, fields: Map<string, Field>, node: string, issues: Issue[] = []): Issue[] {
  if ('all' in rule) rule.all.forEach(r => checkRule(r, fields, node, issues))
  else if ('any' in rule) rule.any.forEach(r => checkRule(r, fields, node, issues))
  else if ('not' in rule) checkRule(rule.not, fields, node, issues)
  else {
    const f = fields.get(rule.ref)
    if (!f) return issues.push({ node, code: 'unknown_ref', message: `"${rule.ref}" is not available here` }), issues
    if (!OPS_BY_TYPE[f.type].includes(rule.op)) {
      return issues.push({ node, code: 'bad_operator', message: `"${rule.op}" does not work on ${f.type} field "${rule.ref}"` }), issues
    }
    if (VALUELESS.includes(rule.op)) {
      if (rule.value !== undefined || rule.valueRef !== undefined) {
        issues.push({ node, code: 'bad_value', message: `"${rule.op}" takes no value` })
      }
      return issues
    }
    // contains on a list compares against one item (string)
    const itemType: FieldType = f.type === 'list' ? 'string' : f.type
    const listOp = rule.op === 'between' || rule.op === 'in' || rule.op === 'nin'
    if (rule.valueRef !== undefined && listOp) {
      issues.push({ node, code: 'bad_value', message: `"${rule.op}" needs literal values, not another field` })
      return issues
    }
    if (rule.valueRef !== undefined) {
      const g = fields.get(rule.valueRef)
      if (!g) issues.push({ node, code: 'unknown_ref', message: `"${rule.valueRef}" is not available here` })
      else if (!compatible(itemType, g.type)) {
        issues.push({ node, code: 'type_mismatch', message: `"${rule.ref}" (${f.type}) can't be compared with "${rule.valueRef}" (${g.type})` })
      }
      return issues
    }
    const v = rule.value
    const ok = rule.op === 'between'
      ? Array.isArray(v) && v.length === 2 && v.every(x => valueOk(itemType, x))
      : rule.op === 'in' || rule.op === 'nin'
        ? Array.isArray(v) && v.length > 0 && v.every(x => valueOk(itemType, x))
        : valueOk(itemType, v)
    if (!ok) issues.push({ node, code: 'bad_value', message: `"${rule.ref}" ${rule.op}: value does not fit a ${f.type} field` })
    if (ok && rule.op === 'between' && ord((v as unknown[])[0]) > ord((v as unknown[])[1])) {
      issues.push({ node, code: 'bad_value', message: `"${rule.ref}" between: the lower bound is above the upper bound` })
    }
    if (ok && f.type === 'enum' && f.options) {
      const vals = (Array.isArray(v) ? v : [v]) as string[]
      const bad = vals.filter(x => !f.options!.includes(x))
      if (bad.length) issues.push({ node, code: 'bad_value', message: `"${rule.ref}" has no option ${bad.map(b => `"${b}"`).join(', ')}` })
    }
  }
  return issues
}

// ---------- condition node ----------

export interface ConditionConfig {
  branches: { key: string, label: string, rule: Rule }[]
  on_missing: boolean
}

export const DEFAULT_BRANCH = 'default'
export const MISSING_BRANCH = 'missing'

export const conditionBranchKeys = (c: ConditionConfig) =>
  [...c.branches.map(b => b.key), DEFAULT_BRANCH, ...(c.on_missing ? [MISSING_BRANCH] : [])]

export interface ConditionEvaluation {
  branch: string
  missing: string[]
  branches: { key: string, result: boolean, trace: TraceEntry[] }[]
}

// Branches in order. With on_missing, a branch whose data is missing stops the walk at the missing
// branch, so a decision is never made by skipping over data we don't have. Missing data in branches
// after the first match doesn't matter. No match → default.
// The returned evaluation is stored on the run: it is the "why" behind every decision.
export function pickBranch(config: ConditionConfig, ctx: unknown): ConditionEvaluation {
  const missingIn = (rule: Rule) => [...new Set(refsInRule(rule, [], true))].filter(r => isMissing(resolvePath(ctx, r)))
  const branches = config.branches.map(b => ({ key: b.key, ...evaluate(b.rule, ctx) }))
  const missing = [...new Set(config.branches.flatMap(b => missingIn(b.rule)))]
  for (const [i, b] of config.branches.entries()) {
    if (config.on_missing && missingIn(b.rule).length) return { branch: MISSING_BRANCH, missing, branches }
    if (branches[i]!.result) return { branch: b.key, missing, branches }
  }
  return { branch: DEFAULT_BRANCH, missing, branches }
}
