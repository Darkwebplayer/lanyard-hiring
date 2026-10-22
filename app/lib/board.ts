import { REGISTRY } from '~~/shared/workflow/registry'

// Where a card sits on the pipeline board: a step (active) or an outcome (closed). Same shape the moves API takes as `from`.
export type Pos = { node: string } | { closed: 'hired' | 'rejected' | 'withdrawn' }
export interface Person { id: string, name: string, email: string, at: Pos }
export interface Row { id: string, pos: Pos, label: string, type?: string }
export const posId = (p: Pos) => 'node' in p ? `n:${p.node}` : `c:${p.closed}`
// People only wait at steps that do work (auto) or need someone (task); the rest pass straight through.
export const resting = (type: string) => ['auto', 'human'].includes(REGISTRY[type]?.kind ?? '')
