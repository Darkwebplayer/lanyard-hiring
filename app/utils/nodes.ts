// One face per step type, everywhere it appears: canvas, timeline, inbox, pipeline.
// slot: who acts. accent = a person, ink = the system, ok/bad = how it ended.
export const NODE_META: Record<string, { icon: string, noun: string, slot: 'accent' | 'ink' | 'ok' | 'line' }> = {
  application_received: { icon: 'enter', noun: 'Application received', slot: 'line' },
  cv_parse: { icon: 'scan', noun: 'CV extraction', slot: 'ink' },
  ai_review: { icon: 'ai', noun: 'AI screening', slot: 'ink' },
  ai_check: { icon: 'check', noun: 'Answer screening', slot: 'ink' },
  set_variable: { icon: 'braces', noun: 'Set fields', slot: 'line' },
  condition: { icon: 'split', noun: 'Decision', slot: 'line' },
  human_task: { icon: 'person', noun: 'Assigned task', slot: 'accent' },
  request_documents: { icon: 'file', noun: 'Document request', slot: 'accent' },
  send_email: { icon: 'mail', noun: 'Send email', slot: 'ink' },
  end: { icon: 'flag', noun: 'Outcome', slot: 'line' },
}

export const nodeMeta = (type: string) => NODE_META[type] ?? { icon: 'more', noun: type, slot: 'line' as const }

const ACRONYMS = new Set(['cv', 'ai', 'hr', 'id'])
export const humanizeKey = (key: string) => {
  const s = key.split('_').filter(Boolean).map(w => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// One name per step everywhere: the label, else the key read as words ("manual_review" → "Manual review").
// Short keys ("ai", "cv") and the trigger read as their type ("AI review", "Read CV", "Start").
export const nodeLabel = (n: { key: string, type: string, label?: string | null }) =>
  n.label?.trim() || (n.key.length <= 3 || n.type === 'application_received' ? nodeMeta(n.type).noun : humanizeKey(n.key))

export const RUN_STATUS: Record<string, { text: string, chip: string, icon: string }> = {
  pending: { text: 'Queued', chip: '', icon: 'clock' },
  running: { text: 'Running', chip: '', icon: 'clock' },
  waiting_on_human: { text: 'With a person', chip: '', icon: 'person' },
  completed: { text: 'Done', chip: 'chip-ok', icon: 'check' },
  failed: { text: 'Failed', chip: 'chip-bad', icon: 'stop' },
  cancelled: { text: 'Skipped', chip: '', icon: 'x' },
}

export const OUTCOME: Record<string, { text: string, chip: string }> = {
  hired: { text: 'Hired', chip: 'chip-ok' },
  rejected: { text: 'Rejected', chip: '' },
  withdrawn: { text: 'Withdrawn', chip: '' },
}

// What a manager does about each run error (docs/backend.md §5). hasReview: the flow has a person step that
// reviews applications, so "a manual review" names a real place to move them.
export function runErrorText(error: string | null | undefined, hasReview = false): { what: string, fix: string } {
  const e = error ?? ''
  if (e.startsWith('no_assignees')) return { what: 'Nobody could be assigned', fix: 'Give someone the role this step uses, then retry.' }
  if (/^(missing_file|file_not_found|checksum_mismatch)/.test(e)) return { what: 'The CV is missing or was changed', fix: 'Move the candidate on by hand.' }
  if (e.startsWith('unreadable_cv')) return { what: 'The CV can’t be read', fix: `It may be a scan. Move it to ${hasReview ? 'a manual review' : 'another step'}.` }
  if (e.startsWith('ai_off')) return { what: 'AI is off', fix: 'An admin can turn on Use AI in Settings, then retry.' }
  if (e.startsWith('ai_quota')) return { what: 'The AI usage limit was reached', fix: 'Retry later, or ask an admin to upgrade the AI key.' }
  if (/^(ai_not_configured|ai_error)/.test(e)) return { what: 'The AI step couldn’t run', fix: 'Check the AI settings, then retry.' }
  if (e.startsWith('missing_ref')) return { what: 'The email had an empty field', fix: 'Move the candidate on, or fix their data and retry.' }
  if (e.startsWith('email_failed')) return { what: 'The email provider refused the email', fix: 'Retry.' }
  if (e.startsWith('disabled')) return { what: 'This kind of step is switched off', fix: 'Switch it back on, then retry.' }
  if (/^(invalid_config|no_handler)/.test(e)) return { what: 'This step is set up wrong', fix: 'Ask a developer to look at it.' }
  return { what: 'A temporary error, three times in a row', fix: 'Retry.' }
}
