import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { flowPresets } from '../db/schema'
import { DomainError } from './errors'
import { draftShape } from './jobs'

const name = z.string().trim().min(1).max(100)
const description = z.string().trim().max(300)

// Saved like a draft: problems are allowed, publish is the gate when a job uses it.
export const flowPresetInput = draftShape.extend({ name, description: description.default('') })
// Rename, or replace the whole form and flow; never one half of them. No defaults, so a rename keeps the description.
const naming = z.object({ name: name.optional(), description: description.optional() })
export const flowPresetPatch = z.union([naming.strict(), draftShape.extend(naming.shape)])
  .refine(p => Object.keys(p).length > 0, 'nothing to change')

export const listFlowPresets = (db: Db) => db.select().from(flowPresets).orderBy(asc(flowPresets.name), asc(flowPresets.createdAt))

export async function createFlowPreset(db: Db, input: z.output<typeof flowPresetInput>) {
  const [row] = await db.insert(flowPresets).values(input).returning()
  return row!
}

export async function updateFlowPreset(db: Db, id: string, patch: z.output<typeof flowPresetPatch>) {
  const [row] = await db.update(flowPresets).set(patch).where(eq(flowPresets.id, id)).returning()
  if (!row) throw new DomainError(404, 'flow_preset_not_found')
  return row
}

export async function deleteFlowPreset(db: Db, id: string) {
  const [row] = await db.delete(flowPresets).where(eq(flowPresets.id, id)).returning()
  if (!row) throw new DomainError(404, 'flow_preset_not_found')
  return row
}
