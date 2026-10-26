import { z } from 'zod'
import { submitApplication, type Submission } from '../../../../domain/apply'
import { verifyTurnstile } from '../../../../domain/turnstile'
import { deliverLater } from '../../../../domain/emails'
import { startApplication } from '../../../../engine/engine'
import { engineDeps, mailer } from '../../../../engine/worker'

const MAX_BODY = 25 * 1024 * 1024 // a few 10 MB files plus fields

// Multipart: core fields, answers keyed by form field key, files for file fields.
// The Turnstile token comes in the `cf-turnstile-response` header so it is checked before the body is read.
// Responds once the application is committed; the workflow runs in the background.
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  // workerd enforces Content-Length, so requiring it caps what readFormData buffers (chunked bodies are refused)
  const length = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(length) || length <= 0) throw createError({ statusCode: 411, message: 'length_required' })
  if (length > MAX_BODY) throw createError({ statusCode: 413, message: 'too_large' })
  const env = useEnv(event)

  // Cloudflare's dummy test secrets don't report our hostname, so the hostname check is skipped for them
  const testSecret = /^[123]x0+AA$/.test(env.TURNSTILE_SECRET ?? '')
  const human = await verifyTurnstile(env.TURNSTILE_SECRET, getRequestHeader(event, 'cf-turnstile-response'), getRequestHeader(event, 'cf-connecting-ip'), fetch,
    testSecret ? undefined : new URL(env.BETTER_AUTH_URL).hostname)
  if (!human) throw createError({ statusCode: 400, message: 'turnstile_failed' })

  const body = await readFormData(event).catch(() => { throw createError({ statusCode: 400, message: 'expected_multipart' }) })
  const sub: Submission = { fields: {}, files: {} }
  for (const [name, value] of body.entries()) {
    if (typeof value === 'string') {
      const prev = sub.fields[name]
      sub.fields[name] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value]
    }
    else if (!sub.files[name]) sub.files[name] = { bytes: new Uint8Array(await value.arrayBuffer()), name: value.name }
  }

  const db = useDb(event)
  const applicationId = await domain(submitApplication(db, env.CV_BUCKET, id, sub, new Date(), env.BETTER_AUTH_URL))
  await deliverLater(db, mailer(env), applicationId)
  try {
    await startApplication(engineDeps(env, db), applicationId)
  }
  catch (e) {
    console.error('[apply] start failed; the sweeper will start it', applicationId, e) // the application is saved either way
  }
  setResponseStatus(event, 201)
  return { ok: true }
})
