import { isMissing, resolvePath } from './rules'

const TAG = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*\}\}/g

export const refsInTemplate = (tpl: string) => [...new Set([...tpl.matchAll(TAG)].map(m => m[1]!))]

export class MissingRefError extends Error {
  constructor(readonly refs: string[]) { super(`missing_ref: ${refs.join(', ')}`) }
}

const show = (v: unknown) => Array.isArray(v) ? v.join(', ') : String(v)

// strict (emails): any missing ref throws, so nobody gets "Dear ,". Non-strict renders missing as ''.
export function render(tpl: string, ctx: unknown, { strict = false } = {}): string {
  const missing = refsInTemplate(tpl).filter(r => isMissing(resolvePath(ctx, r)))
  if (strict && missing.length) throw new MissingRefError(missing)
  return tpl.replace(TAG, (_, path: string) => {
    const v = resolvePath(ctx, path)
    return isMissing(v) ? '' : show(v)
  })
}
