import { z } from 'zod'
import { askWhere, assertAiOn, contextFor } from '../../domain/ask'

// What the Ask panel shows before a question: the header chip, placeholder and suggested questions.
// params and query arrive as JSON strings (the page's route params and URL query).
const json = z.string().max(2000).default('{}').transform((s, ctx) => {
  try { return askWhere.shape.params.parse(JSON.parse(s)) }
  catch { ctx.addIssue({ code: 'custom', message: 'must be a JSON object of strings' }); return z.NEVER }
})
const query = askWhere.extend({ params: json, query: json })

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const where = await getValidatedQuery(event, query.parse)
  const db = useDb(event)
  const env = useEnv(event)
  await domain(assertAiOn(db, env))
  const { label, initials, scope, placeholder, suggestions } = await domain(contextFor(db, { userId: actor.user.id, level: actor.level }, where, env.ADMIN_EMAIL))
  return { label, initials, scope, placeholder, suggestions }
})
