import { z } from 'zod'
import { submitApplication, type Submission } from '../../../../domain/apply'
import { verifyTurnstile } from '../../../../domain/turnstile'
import { startApplication } from '../../../../engine/engine'
import { engineDeps } from '../../../../engine/worker'

const MAX_BODY = 25 * 1024 * 1024 // a few 10 MB files plus fields

// Multipart: core fields, answers keyed by form field key, files for file fields, Turnstile token.
// Responds once the application is committed; the workflow runs in the background.
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY) throw createError({ statusCode: 413, message: 'too_large' })
  const env = useEnv(event)

  const body = await readFormData(event).catch(() => { throw createError({ statusCode: 400, message: 'expected_multipart' }) })
  const human = await verifyTurnstile(env.TURNSTILE_SECRET, body.get('cf-turnstile-response')?.toString(), getRequestHeader(event, 'cf-connecting-ip'))
  if (!human) throw createError({ statusCode: 400, message: 'turnstile_failed' })

  const sub: Submission = { fields: {}, files: {} }
  for (const [name, value] of body.entries()) {
    if (name === 'cf-turnstile-response') continue
    if (typeof value === 'string') {
      const prev = sub.fields[name]
      sub.fields[name] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value]
    }
    else if (!sub.files[name]) sub.files[name] = { bytes: new Uint8Array(await value.arrayBuffer()), name: value.name }
  }

  const db = useDb(event)
  const applicationId = await domain(submitApplication(db, env.CV_BUCKET, id, sub, new Date()))
  try {
    await startApplication(engineDeps(env, db), applicationId)
  }
  catch (e) {
    console.error('[apply] start failed; the sweeper will start it', applicationId, e) // the application is saved either way
  }
  setResponseStatus(event, 201)
  return { ok: true }
})
