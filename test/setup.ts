import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export function testPgUrl() {
  const url = process.env.TEST_PG_URL
  if (!url) throw new Error('TEST_PG_URL is not set in .env')
  // this truncates every table, so only ever touch a database whose name says it's for tests
  const name = new URL(url).pathname.slice(1)
  if (!name.endsWith('_test')) throw new Error(`TEST_PG_URL database "${name}" must end in _test`)
  return { url, name }
}

// Empties every table and re-seeds the default roles. Each test file starts from this, like PGlite.
export async function resetPg(url: string) {
  const sql = postgres(url, { onnotice: () => {} })
  const tables = await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public'`
  await sql.unsafe(`truncate ${tables.map(r => `"${r.t}"`).join(', ')} restart identity cascade`)
  await sql`insert into roles (name, level) values ('Manager', 'manager'), ('Employee', 'employee')`
  await sql.end()
}

// Real-Postgres mode only (`pnpm test:pg`): create the test db if needed and migrate it.
// PGlite mode needs nothing: each file gets a fresh db.
export async function setup() {
  try { process.loadEnvFile() } catch {} // .env is optional (CI)
  if (!process.env.TEST_PG) return
  const { url, name } = testPgUrl()
  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'
  const admin = postgres(adminUrl.toString(), { onnotice: () => {} })
  const [exists] = await admin`select 1 from pg_database where datname = ${name}`
  if (!exists) await admin.unsafe(`create database "${name}"`)
  await admin.end()

  const sql = postgres(url, { onnotice: () => {} })
  await migrate(drizzle(sql), { migrationsFolder: './server/db/migrations' })
  await sql.end()
}
