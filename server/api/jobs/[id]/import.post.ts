import { z } from 'zod'
import { importCandidates, MAX_IMPORT_ROWS } from '../../../domain/import'
import { startApplication } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

const SYNC_STARTS = 50 // above this, one queue message per person (like a whole-step board move)

// Spreadsheet import. The browser parses the file (shared/csv.ts) and sends rows mapped to these keys;
// each row is checked here and problems come back per spreadsheet row, so the shape is loose on purpose.
const body = z.object({
  rows: z.array(z.object({
    first_name: z.unknown(),
    last_name: z.unknown(),
    email: z.unknown(),
    phone: z.unknown(),
    answers: z.record(z.string(), z.unknown()).optional(),
    note: z.string().max(2000).optional(),
    start: z.string().min(1).optional(),
  })).max(MAX_IMPORT_ROWS),
  start: z.string().min(1).nullable(),
  dryRun: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const { rows, start, dryRun } = await readValidatedBody(event, body.parse)
  const db = useDb(event)
  const env = useEnv(event)
  const { ids, ...summary } = await domain(importCandidates(db, id, rows, start, actor.user.id, !!dryRun))
  if (dryRun) return summary

  // Committed already; a start that fails or never arrives is picked up by the sweeper.
  if (ids.length <= SYNC_STARTS) {
    const deps = engineDeps(env, db)
    for (const appId of ids) await startApplication(deps, appId).catch(e => console.error('[import] start failed; the sweeper will start it', appId, e))
  }
  else {
    const msgs = ids.map(start => ({ body: { start } }))
    for (let i = 0; i < msgs.length; i += 100) await env.ENGINE.sendBatch(msgs.slice(i, i + 100)) // sendBatch takes at most 100
  }
  return { ...summary, imported: ids.length }
})
