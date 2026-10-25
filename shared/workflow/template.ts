import { isMissing, resolvePath } from './rules'

const TAG = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*\}\}/g

export const refsInTemplate = (tpl: string) => [...new Set([...tpl.matchAll(TAG)].map(m => m[1]!))]

// {{…}} that isn't a valid ref would otherwise go out literally (e.g. {{Candidate.name}})
export const badTagsIn = (tpl: string) => [...tpl.matchAll(/\{\{[^}]*\}\}/g)].map(m => m[0]).filter(t => !new RegExp(TAG.source).test(t))

export class MissingRefError extends Error {
  constructor(readonly refs: string[]) { super(`missing_ref: ${refs.join(', ')}`) }
}

// A bare ISO date reads as "1 December 2026", the form the Library preview shows; anything else as is.
const longDate = (d: string, t = new Date(`${d}T00:00:00Z`)) =>
  Number.isNaN(+t) || t.toISOString().slice(0, 10) !== d ? d : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const show = (v: unknown) => Array.isArray(v) ? v.join(', ') : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? longDate(v) : String(v)

// strict (emails): any missing ref throws, so nobody gets "Dear ,". Non-strict renders missing as ''.
export function render(tpl: string, ctx: unknown, { strict = false } = {}): string {
  const missing = refsInTemplate(tpl).filter(r => isMissing(resolvePath(ctx, r)))
  if (strict && missing.length) throw new MissingRefError(missing)
  return tpl.replace(TAG, (_, path: string) => {
    const v = resolvePath(ctx, path)
    return isMissing(v) ? '' : show(v)
  })
}
