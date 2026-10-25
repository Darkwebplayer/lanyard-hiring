import { askInput, askStream, assertAiOn, contextFor } from '../domain/ask'

// Streams a plain-text answer. The client sends only where it is; the context is built here under the page's access rules.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { question, history, ...where } = await readValidatedBody(event, askInput.parse)
  const db = useDb(event)
  const env = useEnv(event)
  await domain(assertAiOn(db, env))
  const ctx = await domain(contextFor(db, { userId: actor.user.id, level: actor.level }, where, env.ADMIN_EMAIL))
  return domain(askStream(env, ctx, question, history))
})
