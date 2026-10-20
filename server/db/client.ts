import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Any Postgres driver (postgres-js in the Worker, PGlite in tests). Domain and engine code take this.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema> & { close: () => Promise<void> }

// One client per request/batch: Workers can't share sockets across requests.
// Hyperdrive does the real pooling, so keep this small.
export function createDb(connectionString: string): Db {
  const client = postgres(connectionString, { max: 5, fetch_types: false, prepare: true })
  return Object.assign(drizzle(client, { schema }), { close: () => client.end() })
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
