// QA only: mint a signed better-auth session cookie for an existing user (dev DB).
// usage: tsx --env-file=.env scripts/qa-session.mts <email>
import { createHmac, randomBytes } from 'node:crypto'
import postgres from 'postgres'

const email = process.argv[2]?.toLowerCase()
if (!email) throw new Error('usage: qa-session.mts <email>')
const sql = postgres(process.env.NEON_POSTGRES_DB!)
const [u] = await sql`select id from "user" where email = ${email}`
if (!u) throw new Error(`no user ${email}`)
const token = randomBytes(24).toString('base64url')
await sql`insert into session (id, user_id, token, expires_at, created_at, updated_at, user_agent)
  values (${randomBytes(16).toString('hex')}, ${u.id}, ${token}, now() + interval '7 days', now(), now(), 'qa-session')`
const sig = createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(token).digest('base64')
console.log(encodeURIComponent(`${token}.${sig}`))
await sql.end()
