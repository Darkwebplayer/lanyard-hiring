import { HUMAN_TASK_PRESETS } from './registry'
import { STANDARD_HIRE } from './templates'

// Palette sections, by step type. Start has none (one per flow, never added).
export const PRESET_SECTIONS = [
  { key: 'system', label: 'System steps', types: ['cv_parse', 'ai_review', 'send_email'] },
  { key: 'decisions', label: 'Decisions', types: ['condition', 'set_variable'] },
  { key: 'person', label: 'Person steps', types: ['human_task'] },
  { key: 'endings', label: 'Endings', types: ['end'] },
] as const
export const PRESET_TYPES: string[] = PRESET_SECTIONS.flatMap(s => [...s.types])

const fromTemplate = (key: string) => structuredClone(STANDARD_HIRE.workflow.nodes.find(n => n.key === key)!.config)
const owner = { users: [], roles: [], job_owner: true }

// The presets a new company starts with (seeded by migration 0006, so editing this list changes nothing
// for existing companies). Kept here so the seed and the tests read one source.
export const BUILTIN_PRESETS: { type: string, label: string, description: string, config: unknown }[] = [
  { type: 'ai_review', label: 'AI review: skills and experience', description: 'Scores the CV against the must-have skills and the minimum years.', config: fromTemplate('ai') },
  { type: 'send_email', label: 'Offer email', description: 'Tells the candidate they have an offer.', config: fromTemplate('offer_email') },
  { type: 'send_email', label: 'Rejection email', description: 'Thanks the candidate and says how to ask for another look.', config: fromTemplate('rejection_email') },
  { type: 'condition', label: 'Screen by AI score', description: 'Shortlist at 70 or more, reject under 40, a person reviews the rest.', config: fromTemplate('screen') },
  ...Object.values(HUMAN_TASK_PRESETS).map(p => ({ type: 'human_task', label: p.label, description: `${p.config.scorecard.length} questions, due in ${p.config.due_days} days.`, config: { ...structuredClone(p.config), assignees: owner } })),
  { type: 'end', label: 'Hired', description: 'Closes the application as hired.', config: { outcome: 'hired' } },
  { type: 'end', label: 'Rejected', description: 'Closes the application as rejected.', config: { outcome: 'rejected' } },
  { type: 'end', label: 'Withdrawn', description: 'Closes the application as withdrawn.', config: { outcome: 'withdrawn' } },
]
