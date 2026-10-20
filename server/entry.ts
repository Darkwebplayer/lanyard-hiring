// Custom Worker entry. Nitro's default `queue` export fires the `cloudflare:queue` hook inside
// waitUntil and returns at once, so Cloudflare acks the batch before work finishes and long
// handlers (AI calls) can be cut off. Here the queue and cron handlers await the engine instead.
import nitro from 'nitropack/presets/cloudflare/runtime/cloudflare-module'
import type { AppEnv } from './env'
import { consume, scheduled } from './engine/worker'

export default {
  ...nitro,
  async queue(batch: MessageBatch<{ runId: string }>, env: Env) {
    ;(globalThis as any).__env__ = env
    await consume(batch, env as AppEnv)
  },
  async scheduled(controller: ScheduledController, env: Env) {
    ;(globalThis as any).__env__ = env
    await scheduled(controller.cron, env as AppEnv)
  },
}
