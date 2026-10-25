import { JOB_FIELDS } from './graph'
import { refsInTemplate } from './template'
import type { Graph, GraphNode } from './types'

// What a flow carries from the job it was built in. Configs may be half-built (drafts), so nothing here assumes a shape.

type Assignees = { users?: string[], roles?: string[], job_owner?: boolean }
const assigneesOf = (n: GraphNode) => (n.config as { assignees?: Assignees } | null)?.assignees

// Person steps assigned to named people: those people may not exist, or fit, in the next job.
export const namedPeople = (workflow: Graph) =>
  workflow.nodes.filter(n => (n.type === 'human_task' || n.type === 'request_documents') && (assigneesOf(n)?.users?.length ?? 0) > 0)

// Named people become "the job owner"; roles stay (they're company-wide); steps without named people are untouched.
export function withoutNamedPeople(workflow: Graph): Graph {
  const out = structuredClone(workflow)
  for (const n of namedPeople(out)) {
    const a = assigneesOf(n)!
    a.users = []
    a.job_owner = true
  }
  return out
}

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []

// Title and openings are always set on a job, so only the optional requirements are worth flagging.
const ALWAYS_SET = new Set(['job.title', 'job.openings'])
const READABLE = JOB_FIELDS.filter(f => !ALWAYS_SET.has(f.path))

// The job.* requirements a flow reads: a ref as a whole config value ({ ref }, valueRef, source.ref) or inside {{…}}.
// AI review sends every requirement to the model, so it counts as reading skills and years.
export function jobFieldsRead(workflow: Graph) {
  const used = new Set(workflow.nodes.flatMap(n => strings(n.config).flatMap(s => [s, ...refsInTemplate(s)])))
  if (workflow.nodes.some(n => n.type === 'ai_review' || n.type === 'ai_check')) used.add('job.must_have_skills').add('job.min_experience_years')
  return READABLE.filter(f => used.has(f.path))
}
