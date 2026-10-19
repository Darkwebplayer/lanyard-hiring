import { sql } from 'drizzle-orm'
import { roles } from '../../db/schema'

// Phase 0 spike: a write + rollback inside a transaction through Hyperdrive. Delete after phase 0.
export default defineEventHandler(async (event) => {
  const db = useDb(event)
  const name = `spike-${crypto.randomUUID()}`
  let seen = 0
  await db.transaction(async (tx) => {
    await tx.insert(roles).values({ name, level: 'employee' })
    seen = (await tx.execute(sql`select count(*)::int as n from roles where name = ${name}`))[0]!.n as number
    tx.rollback()
  }).catch((e: Error) => { if (e.message !== 'Rollback') throw e })
  const after = (await db.execute(sql`select count(*)::int as n from roles where name = ${name}`))[0]!.n
  return { seenInTx: seen, afterRollback: after }
})
