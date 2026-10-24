import { createDb, type Db } from '../db/client'
import { settings } from '../db/schema'
import { sendReminders } from '../domain/tasks'
import type { AppEnv } from '../env'
import { createAi } from './ai'
import { sendEmail } from './email'
import { DomainError } from '../domain/errors'
import { type EngineDeps, executeAutoRun, moveApplication, type MoveFrom, type MoveInput, type MoveTarget, startApplication, sweep } from './engine'
import { createHandlers } from './handlers'

export function engineDeps(env: AppEnv, db: Db): EngineDeps {
  return {
    db,
    handlers: createHandlers({
      bucket: env.CV_BUCKET,
      ai: createAi(env),
      sendEmail: (key, email) => sendEmail(env, key, email),
      replyTo: async () => (await db.select({ r: settings.replyToEmail }).from(settings))[0]?.r ?? null,
      aiEnabled: async () => (await db.select({ on: settings.aiEnabled }).from(settings))[0]?.on ?? true,
    }),
    adminEmail: env.ADMIN_EMAIL,
    disabledTypes: new Set((env.DISABLED_NODE_TYPES ?? '').split(',').map(s => s.trim()).filter(Boolean)),
    enqueue: async (items) => {
      await env.ENGINE.sendBatch(items.map(i => ({ body: { runId: i.runId }, delaySeconds: i.delaySeconds })))
    },
  }
}

// A board drop of a whole step: one message per application, so thousands never sit in one request.
export interface MoveMessage extends MoveInput { applicationId: string, from: MoveFrom, to: MoveTarget, actorId: string }
export type EngineMessage = { runId: string } | { move: MoveMessage } | { start: string } // start: an imported application id

// Messages are only triggers; Postgres is the source of truth. The engine records its own failures
// and retries, so a message is acked once handled. Only infrastructure errors (db down) redeliver.
export async function consume(batch: MessageBatch<EngineMessage>, env: AppEnv) {
  const db = createDb(env.HYPERDRIVE.connectionString)
  const deps = engineDeps(env, db)
  try {
    for (const msg of batch.messages) {
      const label = 'move' in msg.body ? `move ${msg.body.move.applicationId}` : 'start' in msg.body ? `start ${msg.body.start}` : `run ${msg.body.runId}`
      try {
        if ('start' in msg.body) await startApplication(deps, msg.body.start) // idempotent, so redelivery is harmless
        else if ('move' in msg.body) {
          const m = msg.body.move
          // `from` makes a redelivery or a candidate who moved on meanwhile a no-op
          const result = await moveApplication(deps, m.applicationId, m.to, m, m.actorId, m.from)
            .catch((e) => { if (e instanceof DomainError) return e.message; throw e })
          console.log('[engine]', label, result)
        }
        else console.log('[engine]', label, await executeAutoRun(deps, msg.body.runId))
        msg.ack()
      }
      catch (e) {
        console.error('[engine]', label, 'infrastructure error', e)
        msg.retry({ delaySeconds: 30 })
      }
    }
  }
  finally {
    await db.close()
  }
}

export async function scheduled(cron: string, env: AppEnv) {
  const db = createDb(env.HYPERDRIVE.connectionString)
  try {
    if (cron === '*/5 * * * *') console.log('[engine] sweep', await sweep(engineDeps(env, db)))
    if (cron === '0 8 * * *') {
      console.log('[reminders]', await sendReminders(db, env.ADMIN_EMAIL, env.BETTER_AUTH_URL, new Date(), (key, email) => sendEmail(env, key, email)))
    }
  }
  finally {
    await db.close()
  }
}
