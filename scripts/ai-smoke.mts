// One real call to each model, printing the raw answers. Not a test: it costs a few cents and needs
// `pnpm wrangler login` (Workers AI always runs remotely) and GEMINI_API_KEY in .env.
// Run: pnpm ai:smoke
import { generateText } from 'ai'
import { getPlatformProxy } from 'wrangler'
import type { AppEnv } from '../server/env'
import { clairic, clef, createAi, gemini, geminiModelId } from '../server/engine/ai'
import { draftFlow, geminiDraft } from '../server/domain/flowDraft'
import { STANDARD_HIRE } from '../shared/workflow/templates'

const cv = `Ben Okafor
Barista
Bean There Coffee, Leeds. Barista, March 2025 to November 2025. Ran the espresso bar on weekends, did latte art.
Odeon Leeds. Front of house, December 2025 to now.
Skills: espresso, milk steaming, cash handling, customer service. Food hygiene level 2 certificate.`

const proxy = await getPlatformProxy<Env>({ remoteBindings: true })
  .catch((e: Error) => { console.error(`Workers AI unavailable, skipping Clairic and Clef: ${e.message}`); return null })
const env = { ...proxy?.env, ...process.env } as unknown as AppEnv

async function step(name: string, fn: () => Promise<unknown>) {
  const t = performance.now()
  try { console.log(`\n== ${name}`); console.dir(await fn(), { depth: 6 }) }
  catch (e) { console.error(`\n== ${name} FAILED`, e) }
  console.log(`   ${Math.round(performance.now() - t)}ms`)
}

if (proxy) await step('Clairic', () => clairic(env.AI, cv, {
  current_title: { type: 'text', instructions: 'Most recent job title' },
  months_as_barista: { type: 'duration', unit: 'months', integer: true, instructions: 'Total time working as a barista' },
  skills: { type: 'list', items: 'text' },
  driving_licence: { type: 'text', instructions: 'Driving licence held' },
}))

if (proxy) await step('Clef-flash', () => clef(env.AI, cv, {
  hygiene: { type: 'noul', instructions: 'Does the applicant hold a food hygiene certificate?' },
  role: { type: 'choice', instructions: 'Which role fits best?', criteria: { barista: 'Makes coffee', kitchen: 'Prepares food', floor: 'Serves tables' } },
  coffee: { type: 'score', instructions: 'How much espresso machine experience?', criteria: ['None', 'Under 6 months', '6 to 12 months', '1 to 2 years', 'Over 2 years'] },
}))

await step(`Gemini ${geminiModelId(env, 'fast')}`, async () =>
  (await generateText({ model: gemini(env, 'fast'), prompt: `In one sentence, summarise this CV for a café owner:\n${cv}` })).text)

// The real step path: what ai_review and ai_check send and get back
const input = { job: { title: 'Barista', requirements: { location: 'Leeds' } }, answers: [{ label: 'Available weekends', value: 'Yes, Saturdays' }], cv_text: cv }
const ai = proxy && createAi({ ...env, AI_MOCK: '' }) // the real models even when .env says mock
if (ai) {
  await step(`review (${ai.model})`, () => ai.review(input, [
    { key: 'coffee', label: 'Coffee', description: 'Hands-on espresso machine experience' },
    { key: 'hygiene', label: 'Food hygiene', description: 'Holds a food hygiene certificate' },
  ]))
  await step('check', () => ai.check(input, [
    { key: 'weekends', label: 'Weekends', question: 'Can they work weekends?', kind: 'yes_no' },
    { key: 'role', label: 'Role', question: 'Which role fits best?', kind: 'choice', options: [{ key: 'barista', label: 'Barista' }, { key: 'kitchen', label: 'Kitchen' }, { key: 'floor', label: 'Floor' }] },
  ]))
}

// Describe your flow: the whole draft + repair loop on the smart model
await step(`flow draft (${geminiModelId(env, 'smart')})`, async () => {
  let calls = 0
  const generate = geminiDraft(env)
  const res = await draftFlow(async (m) => { calls++; return generate(m) }, 'Quick phone call with me first. Then a paid two-hour trial shift on a Saturday morning. If the trial goes well, send the offer. Turn away anyone who can\'t work weekends.', STANDARD_HIRE.form)
  return { repairs: calls - 1, summary: res.summary, issues: res.issues, steps: res.workflow.nodes.map(n => `${n.key} (${n.type}) ${n.label ?? ''}`), stages: res.workflow.stages, workflow: JSON.stringify(res.workflow) }
})

await proxy?.dispose()
