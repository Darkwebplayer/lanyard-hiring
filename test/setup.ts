import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Real-Postgres mode only (`pnpm test:pg`): create the test db if needed, migrate, empty every
// table, re-seed the default roles. PGlite mode needs nothing: each file gets a fresh db.
export async function setup() {
  process.loadEnvFile()
  if (!process.env.TEST_PG) return
  const url = process.env.TEST_PG_URL
  if (!url) throw new Error('TEST_PG_URL is not set in .env')
  const name = new URL(url).pathname.slice(1)
  if (name === 'neondb') throw new Error('TEST_PG_URL points at the dev database; use a separate test database')

  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'
  const admin = postgres(adminUrl.toString(), { onnotice: () => {} })
  const [exists] = await admin`select 1 from pg_database where datname = ${name}`
  if (!exists) await admin.unsafe(`create database "${name}"`)
  await admin.end()

  const sql = postgres(url, { onnotice: () => {} })
  await migrate(drizzle(sql), { migrationsFolder: './server/db/migrations' })
  const tables = await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public'`
  await sql.unsafe(`truncate ${tables.map(r => `"${r.t}"`).join(', ')} restart identity cascade`)
  await sql`insert into roles (name, level) values ('Manager', 'manager'), ('Employee', 'employee')`
  await sql.end()
}
