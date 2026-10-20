import { and, asc, eq, inArray, max } from 'drizzle-orm'
import { z } from 'zod'
import { PRESET_SECTIONS, PRESET_TYPES } from '../../shared/workflow/presets'
import { REGISTRY } from '../../shared/workflow/registry'
import type { Db } from '../db/client'
import { stepPresets } from '../db/schema'
import { DomainError } from './errors'

export const presetInput = z.object({
  type: z.string().refine(t => PRESET_TYPES.includes(t), 'not a step type that takes presets'),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).default(''),
  config: z.unknown(),
  inPalette: z.boolean().default(true),
})
export const presetPatch = presetInput.omit({ type: true }).partial()

const sectionOf = (type: string) => PRESET_SECTIONS.find(s => (s.types as readonly string[]).includes(type))!

// Only the shape is checked: field references depend on the flow a preset lands in, and publish checks those.
function parseConfig(type: string, config: unknown) {
  const r = REGISTRY[type]!.config.safeParse(config)
  if (!r.success) throw new DomainError(422, 'invalid_preset', r.error.issues.map(i => ({ code: 'invalid_config', message: `${i.path.join('.') || 'config'}: ${i.message}` })))
  return r.data
}

export const listPresets = (db: Db) => db.select().from(stepPresets).orderBy(asc(stepPresets.position), asc(stepPresets.createdAt))

export async function createPreset(db: Db, input: z.output<typeof presetInput>) {
  const config = parseConfig(input.type, input.config)
  // new presets go to the end of their section
  const [{ last } = { last: null }] = await db.select({ last: max(stepPresets.position) }).from(stepPresets)
    .where(inArray(stepPresets.type, [...sectionOf(input.type).types]))
  const [row] = await db.insert(stepPresets).values({ ...input, config, position: (last ?? -1) + 1 }).returning()
  return row!
}

export async function updatePreset(db: Db, id: string, patch: z.output<typeof presetPatch>) {
  const [current] = await db.select().from(stepPresets).where(eq(stepPresets.id, id))
  if (!current) throw new DomainError(404, 'preset_not_found')
  const config = patch.config === undefined ? undefined : parseConfig(current.type, patch.config)
  const [row] = await db.update(stepPresets).set({ ...patch, config }).where(eq(stepPresets.id, id)).returning()
  return row!
}

export async function deletePreset(db: Db, id: string) {
  const [row] = await db.delete(stepPresets).where(eq(stepPresets.id, id)).returning()
  if (!row) throw new DomainError(404, 'preset_not_found')
  return row
}

// Sets the order of one section: ids are that section's presets, in the new order.
export async function reorderSection(db: Db, section: string, ids: string[]) {
  const s = PRESET_SECTIONS.find(x => x.key === section)
  if (!s) throw new DomainError(422, 'unknown_section')
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: stepPresets.id }).from(stepPresets).where(inArray(stepPresets.type, [...s.types]))
    const known = new Set(rows.map(r => r.id))
    if (ids.length !== known.size || !ids.every(id => known.has(id))) throw new DomainError(409, 'section_changed')
    for (const [position, id] of ids.entries()) {
      await tx.update(stepPresets).set({ position }).where(and(eq(stepPresets.id, id), inArray(stepPresets.type, [...s.types])))
    }
    return tx.select().from(stepPresets).where(inArray(stepPresets.type, [...s.types])).orderBy(asc(stepPresets.position))
  })
}
