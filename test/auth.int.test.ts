import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as s from '../server/db/schema'
import type { AppEnv } from '../server/env'
import { createAuth } from '../server/utils/auth'
import { testDb } from './db'

// Drives Better Auth's own create-user / create-session path (what the Google callback calls),
// so it checks that the hooks are wired and that the Drizzle schema matches Better Auth's.
const tag = `t${Date.now()}`
const email = (n: string) => `${n}.${tag}@example.test`
const env = {
  ADMIN_EMAIL: email('admin'),
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:8799',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
} as AppEnv

let db: Awaited<ReturnType<typeof testDb>>
let auth: ReturnType<typeof createAuth>
let roleId: string

const signUp = async (e: string, emailVerified = true) =>
  (await auth.$context).internalAdapter.createUser({ email: e, name: e, emailVerified })
const signIn = async (userId: string) => (await auth.$context).internalAdapter.createSession(userId)

beforeAll(async () => {
  db = await testDb()
  auth = createAuth(env, db)
  const [admin] = await db.insert(s.user).values({ id: `seed-${tag}`, email: email('seed'), name: 'seed' }).returning()
  ;[{ id: roleId }] = await db.insert(s.roles).values({ name: `Interviewer ${tag}`, level: 'employee' }).returning() as any
  await db.insert(s.invites).values({ email: email('invited'), roleId, invitedBy: admin!.id })
})

afterAll(async () => {
  const users = await db.select({ id: s.user.id }).from(s.user).where(like(s.user.email, `%.${tag}@example.test`))
  const ids = users.map(u => u.id)
  if (ids.length) {
    await db.delete(s.session).where(inArray(s.session.userId, ids))
    await db.delete(s.invites).where(inArray(s.invites.invitedBy, ids))
    await db.delete(s.user).where(inArray(s.user.id, ids))
  }
  await db.delete(s.roles).where(eq(s.roles.id, roleId))
  await db.close()
})

describe('sign-in gate (integration)', () => {
  it('admin email gets in with no invite and no role', async () => {
    const u = await signUp(email('ADMIN'))
    expect(u.email).toBe(email('admin'))
    expect(await signIn(u.id)).toBeTruthy()
  })

  it('invited email gets the invite role and the invite is consumed', async () => {
    const u = await signUp(email('invited'))
    expect((u as any).roleId).toBe(roleId)
    expect(await db.query.invites.findFirst({ where: eq(s.invites.email, email('invited')) })).toBeUndefined()
    expect(await signIn(u.id)).toBeTruthy()
  })

  it('un-invited and unverified emails are refused', async () => {
    await expect(signUp(email('stranger'))).rejects.toThrow(/not_invited/)
    await expect(signUp(email('admin2'), false)).rejects.toThrow(/email_not_verified/)
    expect(await db.query.user.findFirst({ where: eq(s.user.email, email('stranger')) })).toBeUndefined()
  })

  it('deactivated users get no new session', async () => {
    const u = await db.query.user.findFirst({ where: eq(s.user.email, email('invited')) })
    await db.update(s.user).set({ active: false }).where(eq(s.user.id, u!.id))
    await expect(signIn(u!.id)).rejects.toThrow(/no_access/)
  })
})
