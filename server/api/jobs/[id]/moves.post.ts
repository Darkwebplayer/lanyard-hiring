import { z } from 'zod'
import { OUTCOMES } from '../../../../shared/workflow/registry'
import { movable } from '../../../domain/applications'
import { getSettings } from '../../../domain/settings'
import { checkMove, moveApplication } from '../../../engine/engine'
import { engineDeps } from '../../../engine/worker'

// Board drops. `ids` moves picked candidates right away and says where each landed; without `ids`
// everyone at `from` is queued one message each. `dryRun` only counts, for the confirm dialog.
const body = z.object({
  from: z.union([z.object({ node: z.string().min(1) }), z.object({ closed: z.enum(OUTCOMES) })]),
  to: z.union([z.object({ node: z.string().min(1) }), z.object({ close: z.enum(OUTCOMES) })]),
  reason: z.string().trim().max(1000).optional(),
  reasonCode: z.string().trim().max(60).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  ids: z.array(z.uuid()).min(1).max(25).optional(),
  except: z.array(z.uuid()).max(200).optional(), // a group move leaves out the people pulled out on their own
  dryRun: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const { from, to, ids, except, dryRun, ...input } = await readValidatedBody(event, body.parse)
  if ('closed' in from && 'close' in to) throw createError({ statusCode: 422, message: 'already_closed' })
  const db = useDb(event)
  const env = useEnv(event)
  const found = await domain(movable(db, id, from, to, ids, except))
  if (dryRun) return { count: found.ids.length, notInVersion: found.notInVersion }
  // all or nothing: a bad reason or answer is refused before anyone moves (each move checks again on its own flow)
  const { rejectReasons } = await getSettings(db)
  await domain((async () => found.graphs.forEach(g => checkMove(g, from, to, input, rejectReasons)))())

  if (ids) {
    const deps = engineDeps(env, db)
    const moved = []
    for (const appId of found.ids) moved.push({ id: appId, ...await domain(moveApplication(deps, appId, to, input, actor.user.id, from)) })
    return { moved, notInVersion: found.notInVersion }
  }
  const msgs = found.ids.map(applicationId => ({ body: { move: { applicationId, from, to, ...input, actorId: actor.user.id } } }))
  for (let i = 0; i < msgs.length; i += 100) await env.ENGINE.sendBatch(msgs.slice(i, i + 100)) // sendBatch takes at most 100
  return { queued: msgs.length, notInVersion: found.notInVersion }
})
