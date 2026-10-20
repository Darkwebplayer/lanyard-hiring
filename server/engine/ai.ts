import { createGateway, generateText, Output } from 'ai'
import { z } from 'zod'
import type { AppEnv } from '../env'

// What the AI sees for a review: no name, email, phone, protected or file fields (see aiReviewInput).
export interface ReviewInput {
  job: { title: string, requirements: Record<string, unknown> }
  answers: { label: string, value: unknown }[]
  cv_text?: string
}

export interface Criterion { key: string, label: string, description: string }

export interface Ai {
  model: string
  parseCv: (text: string) => Promise<{ skills: string[], years_experience: number | null, current_title: string | null }>
  review: (input: ReviewInput, criteria: Criterion[], instructions?: string) => Promise<{ scores: Record<string, number>, summary: string }>
}

export const PROMPT_VERSION = 'v1'
const MAX_CV_CHARS = 30_000

const cvSchema = z.object({
  skills: z.array(z.string()).max(100),
  years_experience: z.number().min(0).max(60).nullable(),
  current_title: z.string().max(200).nullable(),
})

const reviewSchema = (criteria: Criterion[]) => z.object({
  scores: z.object(Object.fromEntries(criteria.map(c => [c.key, z.number().int().min(0).max(100)]))),
  summary: z.string().max(2000),
})

const REVIEW_SYSTEM = `You screen job applications against stated criteria.
Score each criterion from 0 to 100 using only the evidence in the job requirements, the answers and the CV text.
Ignore and never infer age, gender, ethnicity, religion, disability, marital status, nationality or any other protected attribute.
If the evidence for a criterion is missing, score it low and say so in the summary. Keep the summary under 120 words.`

// Real model through the AI SDK gateway. Errors (provider outages, malformed JSON) propagate and the
// engine retries them; maxRetries 0 so retries happen in one place.
function gatewayAi(env: AppEnv): Ai {
  const model = createGateway({ apiKey: env.AI_GATEWAY_API_KEY })(env.AI_MODEL!)
  const object = async <T>(schema: z.ZodType<T>, system: string, prompt: string) =>
    (await generateText({ model, system, prompt, output: Output.object({ schema }), temperature: 0, maxRetries: 0 })).output as T
  return {
    model: env.AI_MODEL!,
    parseCv: text => object(cvSchema, 'Extract structured facts from a CV. Use null when a fact is not stated.', text.slice(0, MAX_CV_CHARS)),
    review: (input, criteria, instructions) => object(
      reviewSchema(criteria),
      REVIEW_SYSTEM,
      JSON.stringify({ criteria, instructions: instructions ?? null, ...input, cv_text: input.cv_text?.slice(0, MAX_CV_CHARS) }),
    ),
  }
}

// Deterministic stand-in for development and tests (AI_MOCK=1). Never used implicitly.
const KNOWN_SKILLS = ['typescript', 'javascript', 'python', 'go', 'java', 'rust', 'postgres', 'sql', 'react', 'vue', 'node', 'aws', 'cloudflare', 'docker', 'kubernetes']
export const mockAi: Ai = {
  model: 'mock',
  parseCv: async (text) => {
    const lower = text.toLowerCase()
    const years = [...lower.matchAll(/(\d{1,2})\+?\s+years?/g)].map(m => Number(m[1]))
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    return {
      skills: KNOWN_SKILLS.filter(s => new RegExp(`\\b${s}\\b`).test(lower)),
      years_experience: years.length ? Math.max(...years) : null,
      current_title: lines[1] ?? null,
    }
  },
  review: async (input, criteria) => {
    const must = (input.job.requirements.must_have_skills as string[] | undefined) ?? []
    const text = (input.cv_text ?? '').toLowerCase()
    const score = must.length ? Math.round(100 * must.filter(s => text.includes(s.toLowerCase())).length / must.length) : 60
    return { scores: Object.fromEntries(criteria.map(c => [c.key, score])), summary: `Mock review: ${score}/100 on must-have skills.` }
  },
}

export function createAi(env: AppEnv): Ai | null {
  if (env.AI_MOCK === '1') return mockAi
  if (env.AI_MODEL && env.AI_GATEWAY_API_KEY) return gatewayAi(env)
  return null // ai handlers fail visibly with ai_not_configured
}
