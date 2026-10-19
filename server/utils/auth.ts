import type { H3Event } from 'h3'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { AppEnv } from '../env'
import * as schema from '../db/schema'
import { accessLevel, atLeastManager, gateNewUser, type Level } from '../domain/access'

export function createAuth(env: AppEnv, db: Db) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: 'select_account' },
    },
    user: {
      additionalFields: {
        roleId: { type: 'string', required: false, input: false },
        active: { type: 'boolean', required: false, defaultValue: true, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // First sign-in only: admin email or an invite, otherwise refused.
          before: async (u) => {
            const invite = await db.query.invites.findFirst({ where: eq(schema.invites.email, u.email.toLowerCase()) })
            const gate = gateNewUser(u, env.ADMIN_EMAIL, invite)
            if (!gate.ok) throw new APIError('FORBIDDEN', { message: gate.reason })
            return { data: { ...u, email: gate.email, roleId: gate.roleId, active: true } }
          },
          after: async (u) => {
            await db.delete(schema.invites).where(eq(schema.invites.email, u.email))
          },
        },
      },
      session: {
        create: {
          // Every sign-in: deactivated or role-less users get no session.
          before: async (s) => {
            if (!(await loadAccess(db, env, s.userId))) throw new APIError('FORBIDDEN', { message: 'no_access' })
          },
        },
      },
    },
  })
}

async function loadAccess(db: Db, env: AppEnv, userId: string) {
  const [row] = await db
    .select({ user: schema.user, roleLevel: schema.roles.level })
    .from(schema.user)
    .leftJoin(schema.roles, eq(schema.roles.id, schema.user.roleId))
    .where(eq(schema.user.id, userId))
  if (!row) return null
  const level = accessLevel(row.user, row.roleLevel, env.ADMIN_EMAIL)
  return level ? { user: row.user, level } : null
}

// ponytail: auth instance built per request (env + db are per request); cache in a module if init shows up in profiles.
export function useAuth(event: H3Event) {
  return (event.context.auth ??= createAuth(useEnv(event), useDb(event))) as ReturnType<typeof createAuth>
}

export interface Actor {
  user: typeof schema.user.$inferSelect
  level: Level
}

export async function requireUser(event: H3Event): Promise<Actor> {
  if (event.context.actor) return event.context.actor
  const s = await useAuth(event).api.getSession({ headers: event.headers })
  if (!s) throw createError({ statusCode: 401, message: 'unauthenticated' })
  // checked on every request, so deactivation and role changes apply at once
  const access = await loadAccess(useDb(event), useEnv(event), s.user.id)
  if (!access) throw createError({ statusCode: 403, message: 'no_access' })
  return (event.context.actor = access)
}

export async function requireManager(event: H3Event) {
  const actor = await requireUser(event)
  if (!atLeastManager(actor.level)) throw createError({ statusCode: 403, message: 'forbidden' })
  return actor
}

export async function requireAdmin(event: H3Event) {
  const actor = await requireUser(event)
  if (actor.level !== 'admin') throw createError({ statusCode: 403, message: 'forbidden' })
  return actor
}
