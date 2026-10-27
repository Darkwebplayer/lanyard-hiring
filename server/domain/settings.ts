import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import type { Bucket } from './apply'
import { DomainError } from './errors'

// The single settings row, or its defaults before an admin ever saved one.
export async function getSettings(db: Pick<Db, 'select'>) {
  const [row] = await db.select().from(settings)
  return row ?? {
    id: 1, companyName: null, replyToEmail: null, consentText: null, aiNoticeText: null, aiEnabled: true, careersIntro: null, logoKey: null,
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

// ---------- the company logo ----------

export const LOGO_MAX_BYTES = 1024 * 1024
export const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' } as const
export const LOGO_KEY = /^[0-9a-f-]{36}\.(png|jpg|webp|svg)$/
export const logoUrl = (key: string | null | undefined) => key ? `/api/public/logo/${key}` : null

// By magic bytes, never the extension or the client's content-type. SVG is text: it must open with an svg (or xml) tag.
export function sniffLogo(b: Uint8Array): keyof typeof LOGO_TYPES | null {
  if ([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((x, i) => b[i] === x)) return 'png'
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^﻿/, '').trimStart()
  if (/^<(\?xml|svg[\s>]|!--)/.test(head) && /<svg[\s>]/.test(head)) return 'svg'
  return null
}

// Upload or replace: the new key goes live with the row update, then the old file goes.
export async function setLogo(db: Db, bucket: Bucket, bytes: Uint8Array) {
  if (!bytes.length) throw new DomainError(422, 'empty_file')
  if (bytes.length > LOGO_MAX_BYTES) throw new DomainError(413, 'file_too_large')
  const ext = sniffLogo(bytes)
  if (!ext) throw new DomainError(422, 'unsupported_file')
  const key = `${crypto.randomUUID()}.${ext}`
  await bucket.put(`logo/${key}`, bytes, { httpMetadata: { contentType: LOGO_TYPES[ext] } })
  const old = (await getSettings(db)).logoKey
  await db.insert(settings).values({ id: 1, logoKey: key }).onConflictDoUpdate({ target: settings.id, set: { logoKey: key } })
  if (old) await bucket.delete(`logo/${old}`).catch(() => {}) // best effort; an orphan is harmless
  return { logoUrl: logoUrl(key) }
}

export async function removeLogo(db: Db, bucket: Bucket) {
  const old = (await getSettings(db)).logoKey
  await db.update(settings).set({ logoKey: null })
  if (old) await bucket.delete(`logo/${old}`).catch(() => {})
  return { logoUrl: null }
}
