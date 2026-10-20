// One face per step type, everywhere it appears: canvas, timeline, inbox, pipeline.
// slot: who acts. accent = a person, ink = the system, ok/bad = how it ended.
export const NODE_META: Record<string, { icon: string, noun: string, slot: 'accent' | 'ink' | 'ok' | 'line' }> = {
  application_received: { icon: 'enter', noun: 'Start', slot: 'line' },
  cv_parse: { icon: 'scan', noun: 'Read CV', slot: 'ink' },
  ai_review: { icon: 'ai', noun: 'AI review', slot: 'ink' },
  set_variable: { icon: 'braces', noun: 'Set values', slot: 'line' },
  condition: { icon: 'split', noun: 'Decision', slot: 'line' },
  human_task: { icon: 'person', noun: 'Person', slot: 'accent' },
  send_email: { icon: 'mail', noun: 'Email', slot: 'ink' },
  end: { icon: 'flag', noun: 'End', slot: 'line' },
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
  failed: { text: 'Stopped', chip: 'chip-bad', icon: 'stop' },
  cancelled: { text: 'Skipped', chip: '', icon: 'x' },
}

export const OUTCOME: Record<string, { text: string, chip: string }> = {
  hired: { text: 'Hired', chip: 'chip-ok' },
  rejected: { text: 'Rejected', chip: '' },
  withdrawn: { text: 'Withdrawn', chip: '' },
}
