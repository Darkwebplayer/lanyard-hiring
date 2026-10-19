// Phase 0 spike. Delete after phase 0.
export default defineEventHandler(async (event) => {
  const runId = crypto.randomUUID()
  await useEnv(event).ENGINE.send({ runId })
  return { sent: runId }
})
