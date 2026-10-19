import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// One client per request/batch: Workers can't share sockets across requests.
// Hyperdrive does the real pooling, so keep this small.
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 5, fetch_types: false, prepare: true })
  return Object.assign(drizzle(client, { schema }), { close: () => client.end() })
}

export type Db = ReturnType<typeof createDb>
