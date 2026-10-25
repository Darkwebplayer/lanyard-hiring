import { HUMAN_TASK_PRESETS, MAKE_OFFER } from './registry'
import type { FormField, Graph } from './types'

// "Standard hire": tenants clone it. Borderline and missing scores go to a person, never auto-reject.
export const STANDARD_HIRE: { form: FormField[], workflow: Graph } = {
  form: [
    { key: 'cv', label: 'CV (PDF or DOCX)', type: 'file', required: true },
    { key: 'linkedin', label: 'LinkedIn URL', type: 'string', required: false, max: 300 },
    { key: 'notice_period_weeks', label: 'Notice period (weeks)', type: 'number', required: false, min: 0, max: 52 },
  ],
  workflow: {
    nodes: [
      { key: 'start', type: 'application_received', config: {} },
      { key: 'cv', type: 'cv_parse', config: { file_field: 'cv' } },
      {
        key: 'ai',
        type: 'ai_review',
        config: {
          criteria: [
            { key: 'skills_match', label: 'Skills match', description: 'How well the CV matches the must-have skills' },
            { key: 'experience', label: 'Experience', description: 'Relevant experience against the minimum years' },
          ],
          cv_text_ref: 'nodes.cv.text',
        },
      },
      {
        key: 'screen',
        type: 'condition',
        config: {
          branches: [
            { key: 'shortlist', label: 'Shortlist', rule: { ref: 'nodes.ai.overall', op: 'gte', value: 70 } },
            { key: 'reject', label: 'Reject', rule: { ref: 'nodes.ai.overall', op: 'lt', value: 40 } },
          ],
          on_missing: true,
        },
      },
      {
        key: 'manual_review',
        type: 'human_task',
        config: {
          title: 'Review {{candidate.first_name}} {{candidate.last_name}} (score {{nodes.ai.overall}})',
          assignees: { users: [], roles: [], job_owner: true },
          scorecard: [
            { key: 'advance', label: 'Invite to interview?', type: 'boolean', required: true },
            { key: 'notes', label: 'Notes', type: 'text', required: false },
          ],
          min_submissions: 1,
          due_days: 3,
        },
      },
      {
        key: 'review_decision',
        type: 'condition',
        config: { branches: [{ key: 'advance', label: 'Advance', rule: { ref: 'nodes.manual_review.advance', op: 'is_true' } }], on_missing: false },
      },
      {
        key: 'interview',
        type: 'human_task',
        // for a panel: add a role to assignees and set min_submissions to 2
        config: { ...HUMAN_TASK_PRESETS.interview!.config, assignees: { users: [], roles: [], job_owner: true } },
      },
      {
        key: 'decision',
        type: 'condition',
        config: {
          branches: [{
            key: 'hire',
            label: 'Hire',
            rule: { all: [{ ref: 'nodes.interview.hire', op: 'is_true' }, { ref: 'nodes.interview.technical', op: 'gte', value: 3 }] },
          }],
          on_missing: false,
        },
      },
      // the owner makes the offer (it emails the letter); the answer, on the link or recorded, moves them on
      { key: 'make_offer', type: 'human_task', label: 'Make offer', config: { ...MAKE_OFFER, assignees: { users: [], roles: [], job_owner: true } } },
      {
        key: 'offer_answer',
        type: 'condition',
        config: { branches: [{ key: 'accepted', label: 'Accepted', rule: { ref: 'nodes.make_offer.accepted', op: 'is_true' } }], on_missing: false },
      },
      // after a yes: the paperwork, uploaded on the emailed link or ticked off by hand
      {
        key: 'documents',
        type: 'request_documents',
        label: 'Request documents',
        config: {
          documents: [{ label: 'NRIC or work pass', required: true }, { label: 'Bank account details', required: true }, { label: 'Certificates', required: false }],
          assignees: { users: [], roles: [], job_owner: true },
          due_days: 7,
        },
      },
      {
        key: 'rejection_email',
        type: 'send_email',
        config: {
          subject: 'Your application for {{job.title}}',
          body: 'Hi {{candidate.first_name}},\n\nThank you for applying for {{job.title}}. We have decided not to move forward this time. Reply to this email if you would like us to look again.',
        },
      },
      { key: 'hired', type: 'end', config: { outcome: 'hired' } },
      { key: 'withdrawn', type: 'end', config: { outcome: 'withdrawn' } },
      { key: 'rejected', type: 'end', config: { outcome: 'rejected' } },
    ],
    edges: [
      { from: 'start', to: 'cv' },
      { from: 'cv', to: 'ai' },
      { from: 'ai', to: 'screen' },
      { from: 'screen', to: 'interview', branch: 'shortlist' },
      { from: 'screen', to: 'rejection_email', branch: 'reject' },
      { from: 'screen', to: 'manual_review', branch: 'default' },
      { from: 'screen', to: 'manual_review', branch: 'missing' },
      { from: 'manual_review', to: 'review_decision' },
      { from: 'review_decision', to: 'interview', branch: 'advance' },
      { from: 'review_decision', to: 'rejection_email', branch: 'default' },
      { from: 'interview', to: 'decision' },
      { from: 'decision', to: 'make_offer', branch: 'hire' },
      { from: 'decision', to: 'rejection_email', branch: 'default' },
      { from: 'make_offer', to: 'offer_answer' },
      { from: 'offer_answer', to: 'documents', branch: 'accepted' },
      { from: 'documents', to: 'hired' },
      { from: 'offer_answer', to: 'withdrawn', branch: 'default' },
      { from: 'rejection_email', to: 'rejected' },
    ],
    stages: [
      { id: 'screening', name: 'Screening', nodeKeys: ['cv', 'ai', 'manual_review'] },
      { id: 'interview', name: 'Interview', nodeKeys: ['interview'] },
      // hires go on to Offer; only a no lands here, so the column says so
      { id: 'offer', name: 'Offer', nodeKeys: ['make_offer', 'documents'] },
      { id: 'decision', name: 'Not moving on', nodeKeys: ['rejection_email'] },
    ],
  },
}

// ---------- the new-job picker: Standard hire plus three more starting points ----------

type Template = { form: FormField[], workflow: Graph }
const owner = { users: [], roles: [], job_owner: true }
const node = (key: string, type: string, config: unknown) => ({ key, type, config })
const byKey = (key: string) => STANDARD_HIRE.workflow.nodes.find(n => n.key === key)!
const CV = STANDARD_HIRE.form[0]!
const hireIf = (task: string) => node('decision', 'condition', {
  branches: [{ key: 'hire', label: 'Hire', rule: { ref: `nodes.${task}.hire`, op: 'is_true' } }], on_missing: false,
})
// every template ends the same way: a rejection email, or Make offer and their answer, then the outcome
const ENDINGS = ['make_offer', 'offer_answer', 'documents', 'rejection_email', 'hired', 'withdrawn', 'rejected'].map(byKey)
const ENDING_EDGES = STANDARD_HIRE.workflow.edges.filter(e => ['make_offer', 'offer_answer', 'documents', 'rejection_email'].includes(e.from))
const ENDING_STAGES = STANDARD_HIRE.workflow.stages!.filter(s => s.id === 'decision' || s.id === 'offer')

// No AI: the owner reads every application.
const SIMPLE: Template = {
  form: [CV, STANDARD_HIRE.form[1]!],
  workflow: {
    nodes: [
      byKey('start'),
      node('review', 'human_task', {
        title: 'Review {{candidate.first_name}} {{candidate.last_name}}',
        assignees: owner,
        scorecard: [
          { key: 'advance', label: 'Invite to interview?', type: 'boolean', required: true },
          { key: 'notes', label: 'Notes', type: 'text', required: false },
        ],
        min_submissions: 1,
        due_days: 3,
      }),
      node('review_decision', 'condition', {
        branches: [{ key: 'advance', label: 'Advance', rule: { ref: 'nodes.review.advance', op: 'is_true' } }], on_missing: false,
      }),
      node('interview', 'human_task', { ...HUMAN_TASK_PRESETS.interview!.config, assignees: owner }),
      hireIf('interview'),
      ...ENDINGS,
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review', to: 'review_decision' },
      { from: 'review_decision', to: 'interview', branch: 'advance' },
      { from: 'review_decision', to: 'rejection_email', branch: 'default' },
      { from: 'interview', to: 'decision' },
      { from: 'decision', to: 'make_offer', branch: 'hire' },
      { from: 'decision', to: 'rejection_email', branch: 'default' },
      ...ENDING_EDGES,
    ],
    stages: [
      { id: 'review', name: 'Review', nodeKeys: ['review'] },
      { id: 'interview', name: 'Interview', nodeKeys: ['interview'] },
      ...ENDING_STAGES,
    ],
  },
}

// Hourly and entry roles: AI sorts, one short call decides. Missing or middling scores still get the call.
const HIGH_VOLUME: Template = {
  form: [CV, { key: 'right_to_work', label: 'Do you have the right to work here?', type: 'boolean', required: true }],
  workflow: {
    nodes: [
      byKey('start'),
      byKey('cv'),
      node('ai', 'ai_review', {
        criteria: [
          { key: 'experience', label: 'Relevant experience', description: 'Experience that fits this role, paid or unpaid' },
          { key: 'reliability', label: 'Reliability', description: 'Signs of reliability: tenure, references, responsibilities' },
        ],
        cv_text_ref: 'nodes.cv.text',
      }),
      node('screen', 'condition', {
        branches: [{ key: 'reject', label: 'Reject', rule: { ref: 'nodes.ai.overall', op: 'lt', value: 35 } }],
        on_missing: true,
      }),
      node('call', 'human_task', {
        title: 'Call {{candidate.first_name}} {{candidate.last_name}}',
        assignees: owner,
        scorecard: [
          { key: 'hire', label: 'Hire?', type: 'boolean', required: true },
          { key: 'notes', label: 'Notes', type: 'text', required: false },
        ],
        min_submissions: 1,
        due_days: 2,
      }),
      hireIf('call'),
      ...ENDINGS,
    ],
    edges: [
      { from: 'start', to: 'cv' },
      { from: 'cv', to: 'ai' },
      { from: 'ai', to: 'screen' },
      { from: 'screen', to: 'rejection_email', branch: 'reject' },
      { from: 'screen', to: 'call', branch: 'default' },
      { from: 'screen', to: 'call', branch: 'missing' },
      { from: 'call', to: 'decision' },
      { from: 'decision', to: 'make_offer', branch: 'hire' },
      { from: 'decision', to: 'rejection_email', branch: 'default' },
      ...ENDING_EDGES,
    ],
    stages: [
      { id: 'screening', name: 'Screening', nodeKeys: ['cv', 'ai'] },
      { id: 'call', name: 'Call', nodeKeys: ['call'] },
      ...ENDING_STAGES,
    ],
  },
}

// Senior roles: Standard hire with a phone screen before a panel. The panel starts with the job owner;
// add the other interviewers on the step (everyone assigned scores blind).
const PANEL: Template = (() => {
  const t = structuredClone(STANDARD_HIRE)
  const w = t.workflow
  const panel = w.nodes.find(n => n.key === 'interview')!
  panel.label = 'Panel interview'
  ;(panel.config as { instructions?: string }).instructions = 'Add everyone on the panel to this step. Each person scores on their own.'
  w.nodes.push(node('phone_screen', 'human_task', {
    title: 'Phone screen {{candidate.first_name}} {{candidate.last_name}}',
    assignees: owner,
    scorecard: [
      { key: 'advance', label: 'Invite to the panel?', type: 'boolean', required: true },
      { key: 'notes', label: 'Notes', type: 'text', required: false },
    ],
    min_submissions: 1,
    due_days: 3,
  }), node('phone_decision', 'condition', {
    branches: [{ key: 'advance', label: 'Advance', rule: { ref: 'nodes.phone_screen.advance', op: 'is_true' } }], on_missing: false,
  }))
  // everything that went to the interview now goes to the phone screen first
  for (const e of w.edges) if (e.to === 'interview') e.to = 'phone_screen'
  w.edges.push(
    { from: 'phone_screen', to: 'phone_decision' },
    { from: 'phone_decision', to: 'interview', branch: 'advance' },
    { from: 'phone_decision', to: 'rejection_email', branch: 'default' },
  )
  w.stages!.find(s => s.id === 'interview')!.nodeKeys = ['phone_screen', 'interview']
  return t
})()

export const TEMPLATES = [
  { id: 'simple', name: 'Simple', description: 'You review every applicant yourself. No AI.', ...SIMPLE },
  { id: 'ai_screening', name: 'AI screening', description: 'AI scores CVs. You only look at the strong and borderline ones.', ...STANDARD_HIRE },
  { id: 'high_volume', name: 'Lots of applicants', description: 'Hourly or entry roles: a short form, AI screen, one quick call.', ...HIGH_VOLUME },
  { id: 'panel', name: 'Panel interview', description: 'Senior roles: a phone screen, then a panel that scores blind.', ...PANEL },
] as const
export type TemplateId = typeof TEMPLATES[number]['id']
