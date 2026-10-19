// Phase 0 spike: proves queue + cron reach awaited code. Replaced by the real engine in phase 4.
export async function consume(batch: MessageBatch<{ runId: string }>, env: Env) {
  for (const msg of batch.messages) {
    console.log('[engine] queue message', msg.body, 'attempt', msg.attempts)
    msg.ack()
  }
}

export async function scheduled(cron: string, env: Env) {
  console.log('[engine] cron', cron)
}
