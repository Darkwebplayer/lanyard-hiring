import { HUMAN_TASK_PRESETS } from './registry'
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
      {
        key: 'offer_email',
        type: 'send_email',
        config: {
          subject: 'Your offer for {{job.title}}',
          body: 'Hi {{candidate.first_name}},\n\nWe are delighted to offer you the {{job.title}} role. We will be in touch with the details shortly.',
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
      { from: 'decision', to: 'offer_email', branch: 'hire' },
      { from: 'decision', to: 'rejection_email', branch: 'default' },
      { from: 'offer_email', to: 'hired' },
      { from: 'rejection_email', to: 'rejected' },
    ],
    stages: [
      { id: 'screening', name: 'Screening', nodeKeys: ['cv', 'ai', 'manual_review'] },
      { id: 'interview', name: 'Interview', nodeKeys: ['interview'] },
      { id: 'decision', name: 'Decision', nodeKeys: ['offer_email', 'rejection_email'] },
    ],
  },
}
