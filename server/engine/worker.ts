import { createDb, type Db } from '../db/client'
import { settings } from '../db/schema'
import type { AppEnv } from '../env'
import { createAi } from './ai'
import { sendEmail } from './email'
import { type EngineDeps, executeAutoRun, sweep } from './engine'
import { createHandlers } from './handlers'

export function engineDeps(env: AppEnv, db: Db): EngineDeps {
  return {
    db,
    handlers: createHandlers({
      bucket: env.CV_BUCKET,
      ai: createAi(env),
      sendEmail: (key, email) => sendEmail(env, key, email),
      replyTo: async () => (await db.select({ r: settings.replyToEmail }).from(settings))[0]?.r ?? null,
    }),
    adminEmail: env.ADMIN_EMAIL,
    disabledTypes: new Set((env.DISABLED_NODE_TYPES ?? '').split(',').map(s => s.trim()).filter(Boolean)),
    enqueue: async (items) => {
      await env.ENGINE.sendBatch(items.map(i => ({ body: { runId: i.runId }, delaySeconds: i.delaySeconds })))
    },
  }
}

// Messages are only triggers; Postgres is the source of truth. The engine records its own failures
// and retries, so a message is acked once handled. Only infrastructure errors (db down) redeliver.
export async function consume(batch: MessageBatch<{ runId: string }>, env: AppEnv) {
  const db = createDb(env.HYPERDRIVE.connectionString)
  const deps = engineDeps(env, db)
  try {
    for (const msg of batch.messages) {
      try {
        const result = await executeAutoRun(deps, msg.body.runId)
        console.log('[engine] run', msg.body.runId, result)
        msg.ack()
      }
      catch (e) {
        console.error('[engine] run', msg.body.runId, 'infrastructure error', e)
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
    // '0 8 * * *' → overdue reminders (phase 7)
  }
  finally {
    await db.close()
  }
}
