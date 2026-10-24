import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

// The single settings row, or its defaults before an admin ever saved one.
export async function getSettings(db: Pick<Db, 'select'>) {
  const [row] = await db.select().from(settings)
  return row ?? {
    id: 1, companyName: null, replyToEmail: null, consentText: null, aiNoticeText: null, aiEnabled: true, careersIntro: null,
    rejectReasons: settings.rejectReasons.default as string[],
  }
}

export const settingsInput = z.object({
  companyName: z.string().trim().max(200).nullable(),
  replyToEmail: z.email().nullable(),
  consentText: z.string().max(5000).nullable(),
  aiNoticeText: z.string().max(5000).nullable(),
  // the three below may be left out (unchanged), so older clients keep working
  careersIntro: z.string().trim().max(500).nullable().optional(),
  aiEnabled: z.boolean().optional(),
  // events store the reason text itself, so renaming or removing one never rewrites history
  rejectReasons: z.array(z.string().trim().min(1).max(60)).min(1).max(20)
    .refine(r => new Set(r).size === r.length, 'reasons must be unique').optional(),
})
