import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { createDb, type Db } from '../server/db/client'
import * as schema from '../server/db/schema'
import { resetPg, testPgUrl } from './setup'

// Default: a fresh in-memory PGlite per test file (real Postgres in wasm, one connection, so
// concurrent work runs one at a time). `pnpm test:pg` runs the tests tagged [race] on real
// Postgres (TEST_PG_URL) to prove locking under true concurrency; files run one after another
// there and each starts from an emptied database.
export async function testDb(): Promise<Db> {
  if (process.env.TEST_PG) {
    const { url } = testPgUrl()
    await resetPg(url)
    return createDb(url)
  }
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: './server/db/migrations' })
  return Object.assign(db, { close: () => client.close() }) as unknown as Db
}
