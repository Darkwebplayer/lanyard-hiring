import { eq } from 'drizzle-orm'
import { roles } from '../../db/schema'

// Phase 0 spike: a write + rollback inside a transaction through Hyperdrive. Delete after phase 0.
export default defineEventHandler(async (event) => {
  const db = useDb(event)
  const name = `spike-${crypto.randomUUID()}`
  let seenInTx = 0
  await db.transaction(async (tx) => {
    await tx.insert(roles).values({ name, level: 'employee' })
    seenInTx = (await tx.select().from(roles).where(eq(roles.name, name))).length
    tx.rollback()
  }).catch((e: Error) => { if (e.message !== 'Rollback') throw e })
  return { seenInTx, afterRollback: (await db.select().from(roles).where(eq(roles.name, name))).length }
})
