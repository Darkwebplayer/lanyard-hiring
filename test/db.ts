import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { createDb, type Db } from '../server/db/client'
import * as schema from '../server/db/schema'

// Default: a fresh in-memory PGlite per test file (real Postgres in wasm, one connection, so
// concurrent work runs one at a time). `pnpm test:pg` runs the same suite on real Postgres
// (TEST_PG_URL, a Neon test database) to prove locking and races under true concurrency.
export const PG_URL = process.env.TEST_PG ? process.env.TEST_PG_URL : undefined

export async function testDb(): Promise<Db> {
  if (PG_URL) return createDb(PG_URL) // migrated and emptied once by test/setup.ts
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: './server/db/migrations' })
  return Object.assign(db, { close: () => client.close() }) as unknown as Db
}
