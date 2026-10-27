import { sql } from 'drizzle-orm'
import {
  bigint, boolean, check, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const ts = (name: string) => timestamp(name, { withTimezone: true })
// created_at is the transaction start, so rows written in one transaction tie; seq gives their real order
const seq = () => bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity()

// ---------- auth (Better Auth core tables, plus role_id and active on user) ----------

export const roleLevel = pgEnum('role_level', ['manager', 'employee'])

export const roles = pgTable('roles', {
  id: id(),
  name: text('name').notNull().unique(),
  level: roleLevel('level').notNull(),
  createdAt: createdAt(),
})

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // null for the env admin; a non-admin with no role has no access
  roleId: uuid('role_id').references(() => roles.id),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('session_user_idx').on(t.userId)])

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('account_user_idx').on(t.userId)])

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('verification_identifier_idx').on(t.identifier)])

export const invites = pgTable('invites', {
  email: text('email').primaryKey(), // lowercase
  roleId: uuid('role_id').notNull().references(() => roles.id),
  invitedBy: text('invited_by').notNull().references(() => user.id),
  createdAt: createdAt(),
})

export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1), // single row
  companyName: text('company_name'), // shown to candidates on the apply page
  replyToEmail: text('reply_to_email'),
  consentText: text('consent_text'),
  aiNoticeText: text('ai_notice_text'),
  aiEnabled: boolean('ai_enabled').notNull().default(true), // off: AI steps fail with ai_off, Ask and flow drafts hide
  careersIntro: text('careers_intro'), // the line under "Work with us" on /careers
  logoKey: text('logo_key'), // R2 logo/<key>, served at /api/public/logo/<key>; a new upload gets a new key
  // picked when closing as rejected; stored on the event, so renaming one never rewrites history
  rejectReasons: jsonb('reject_reasons').$type<string[]>().notNull()
    .default(['Not enough experience', 'Skills don’t match', 'Salary expectations', 'Position filled', 'Other']),
}, t => [check('settings_single_row', sql`${t.id} = 1`)])

// Library: offer letter templates, Markdown with {{candidate.*}}, {{job.*}}, {{offer.*}} holes.
export const offerTemplates = pgTable('offer_templates', {
  id: id(),
  name: text('name').notNull(),
  body: text('body').notNull(),
  createdAt: createdAt(),
})

// ---------- step presets ----------

// Company-wide starting points for canvas steps. The palette shows the ones with in_palette, in position order
// per section (sections follow the step type). A preset is only a starting config: a step copies it when added.
export const stepPresets = pgTable('step_presets', {
  id: id(),
  type: text('type').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull().default(''),
  config: jsonb('config').notNull(),
  position: integer('position').notNull().default(0),
  inPalette: boolean('in_palette').notNull().default(true),
  createdAt: createdAt(),
})

// Saved form + flow pairs a new job or a draft starts from. Copied on use, like step presets.
export const flowPresets = pgTable('flow_presets', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  form: jsonb('form').notNull(),
  workflow: jsonb('workflow').notNull(),
  createdAt: createdAt(),
})

// ---------- jobs ----------

export const jobStatus = pgEnum('job_status', ['draft', 'open', 'closed', 'archived'])
export const versionStatus = pgEnum('version_status', ['draft', 'published'])

export const jobs = pgTable('jobs', {
  id: id(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  requirements: jsonb('requirements').notNull().default({}),
  openings: integer('openings').notNull().default(1),
  status: jobStatus('status').notNull().default('draft'),
  closesAt: ts('closes_at'),
  ownerId: text('owner_id').notNull().references(() => user.id),
  publishedVersionId: uuid('published_version_id'),
  createdAt: createdAt(),
})

export const jobVersions = pgTable('job_versions', {
  id: id(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  version: integer('version').notNull(),
  status: versionStatus('status').notNull().default('draft'),
  form: jsonb('form').notNull().default([]),
  workflow: jsonb('workflow').notNull().default({ nodes: [], edges: [] }),
  requirements: jsonb('requirements').notNull().default({}), // job requirements frozen at publish
  publishedAt: ts('published_at'),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('job_versions_job_version_uq').on(t.jobId, t.version),
  uniqueIndex('job_versions_one_draft_uq').on(t.jobId).where(sql`${t.status} = 'draft'`),
])

// ---------- candidates & applications ----------

export const candidates = pgTable('candidates', {
  id: id(),
  email: text('email').notNull().unique(), // lowercase
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  phone: text('phone'),
  // the key to their status page (/status/<token>); only ever emailed, since apply doesn't verify the address
  statusToken: text('status_token').notNull().unique().$defaultFn(() => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')),
  createdAt: createdAt(),
})

export const applicationStatus = pgEnum('application_status', ['active', 'closed'])
export const outcome = pgEnum('outcome', ['hired', 'rejected', 'withdrawn'])

export const applications = pgTable('applications', {
  id: id(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  candidateId: uuid('candidate_id').notNull().references(() => candidates.id),
  jobVersionId: uuid('job_version_id').notNull().references(() => jobVersions.id),
  answers: jsonb('answers').notNull().default({}),
  status: applicationStatus('status').notNull().default('active'),
  outcome: outcome('outcome'),
  currentNodeKey: text('current_node_key'), // display cache only; state lives in node_runs
  source: text('source'), // where they came from: ?src / utm_source on apply, 'import', null if unknown
  consent: jsonb('consent').$type<{ text: string, at: string }>(), // the consent text they agreed to; null = not collected (imports)
  createdAt: createdAt(),
}, t => [
  uniqueIndex('applications_job_candidate_uq').on(t.jobId, t.candidateId),
  index('applications_job_idx').on(t.jobId, t.status),
])

// ---------- engine ----------

export const runStatus = pgEnum('run_status', [
  'pending', 'running', 'waiting_on_human', 'completed', 'failed', 'cancelled',
])

export const nodeRuns = pgTable('node_runs', {
  id: id(),
  seq: seq(),
  applicationId: uuid('application_id').notNull().references(() => applications.id),
  nodeKey: text('node_key').notNull(),
  nodeType: text('node_type').notNull(),
  attempt: integer('attempt').notNull(),
  status: runStatus('status').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  branchTaken: text('branch_taken'),
  evaluation: jsonb('evaluation'),
  error: text('error'),
  retries: integer('retries').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at'),
  claimedAt: ts('claimed_at'), // fencing token for completion
  dueAt: ts('due_at'),
  actorId: text('actor_id').references(() => user.id),
  createdAt: createdAt(),
  completedAt: ts('completed_at'),
}, t => [
  uniqueIndex('node_runs_attempt_uq').on(t.applicationId, t.nodeKey, t.attempt),
  // invariant: at most one active run per application (no parallel branches in the MVP)
  uniqueIndex('node_runs_one_active_uq').on(t.applicationId)
    .where(sql`${t.status} in ('pending', 'running', 'waiting_on_human')`),
  index('node_runs_status_idx').on(t.status, t.nextAttemptAt),
])

export const taskAssignments = pgTable('task_assignments', {
  runId: uuid('run_id').notNull().references(() => nodeRuns.id),
  userId: text('user_id').notNull().references(() => user.id),
  assignedAt: createdAt(),
  submittedAt: ts('submitted_at'),
  values: jsonb('values'),
  closedAt: ts('closed_at'),
  // Sent to more people than the step needs: each one takes it (claimedAt) or passes (passedAt, also closed).
  claimedAt: ts('claimed_at'),
  passedAt: ts('passed_at'),
}, t => [
  primaryKey({ columns: [t.runId, t.userId] }),
  index('task_assignments_user_idx').on(t.userId, t.closedAt),
])

export const applicationEvents = pgTable('application_events', {
  id: id(),
  seq: seq(),
  applicationId: uuid('application_id').notNull().references(() => applications.id),
  type: text('type').notNull(),
  actorId: text('actor_id').references(() => user.id),
  data: jsonb('data').notNull().default({}),
  createdAt: createdAt(),
}, t => [
  index('application_events_app_idx').on(t.applicationId, t.seq),
  index('application_events_seq_idx').on(t.seq), // the notices tray reads recent events across every application
])

// One human-task run's interview: the interviewer offers times (booking_offers), the candidate picks one through
// the link (token). starts_at null until they book.
export const bookings = pgTable('bookings', {
  id: id(),
  runId: uuid('run_id').notNull().references(() => nodeRuns.id).unique(),
  token: text('token').notNull().unique(),
  durationMin: integer('duration_min').notNull(),
  location: text('location'), // the step's "Where", copied when the link is made, like the duration
  startsAt: ts('starts_at'),
  cancelledAt: ts('cancelled_at'), // the application moved on (an accepted offer, a close) before the interview
  offeredBy: text('offered_by').references(() => user.id), // who offered the current times; the panel's answers come back to them
  timezone: text('timezone'), // the offerer's, for the times in the email
  sentAt: ts('sent_at'), // the current times went to the candidate (after the whole panel said yes)
  note: text('note'), // the candidate's last words: "none of these work" or why they stepped back
  notedAt: ts('noted_at'), // they asked for other times; cleared when new times go out or they book
  teamNote: text('team_note'), // what the panel said when it answered, for the offerer
  declinedAt: ts('declined_at'), // the candidate stepped back; offering new times clears it
  createdAt: createdAt(),
})

// The times offered for a booking. answers: user id → can make it; the offerer's own yes is written when offered.
// The same time can be offered to several candidates (separate rows): whoever books first takes it.
export const bookingOffers = pgTable('booking_offers', {
  id: id(),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id, { onDelete: 'cascade' }),
  startsAt: ts('starts_at').notNull(),
  answers: jsonb('answers').$type<Record<string, boolean>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [uniqueIndex('booking_offers_time').on(t.bookingId, t.startsAt)])

// A request_documents step's checklist and the candidate's upload link. One per application and step, so moving
// back to the step (or a retry) keeps the link and what came in; run_id follows the step's latest run.
export interface DocItem {
  label: string
  required: boolean
  // set once uploaded (file) or ticked off by the team (by, note)
  received?: { at: string, file?: { key: string, sha256: string, size: number, mime: string, name: string }, by?: { id: string, name: string }, note?: string }
}
export const documentRequests = pgTable('document_requests', {
  id: id(),
  applicationId: uuid('application_id').notNull().references(() => applications.id),
  nodeKey: text('node_key').notNull(),
  runId: uuid('run_id').notNull().references(() => nodeRuns.id),
  token: text('token').notNull().unique(),
  items: jsonb('items').$type<DocItem[]>().notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('document_requests_app_node_uq').on(t.applicationId, t.nodeKey)])

export const offerStatus = pgEnum('offer_status', ['sent', 'accepted', 'declined', 'withdrawn'])

// The letter is rendered once when made, so later template edits never change what the candidate saw.
export const offers = pgTable('offers', {
  id: id(),
  applicationId: uuid('application_id').notNull().references(() => applications.id),
  token: text('token').notNull().unique(),
  terms: jsonb('terms').$type<{ salary: string, start_date: string, location?: string }>().notNull(),
  letter: text('letter').notNull(),
  status: offerStatus('status').notNull().default('sent'),
  expiresAt: ts('expires_at'),
  signedName: text('signed_name'),
  respondedAt: ts('responded_at'),
  // how the answer came: on the link, or recorded by the team (by phone, email, in person) with an optional note
  answer: jsonb('answer').$type<{ via: 'link' | 'phone' | 'email' | 'in_person', reason?: string, note?: string, by?: { id: string, name: string } }>(),
  createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: createdAt(),
}, t => [
  index('offers_application_idx').on(t.applicationId),
  // one live offer per application; a new one withdraws the old
  uniqueIndex('offers_one_sent_uq').on(t.applicationId).where(sql`${t.status} = 'sent'`),
])

// Every email sent to a candidate, word for word: their record on the candidate page. Written in the same
// transaction as what caused it, sent after commit (domain/emails.ts deliver); sent_at once the provider took it.
export const candidateEmails = pgTable('candidate_emails', {
  id: id(),
  seq: seq(),
  applicationId: uuid('application_id').notNull().references(() => applications.id),
  kind: text('kind').notNull(), // flow · offer · offer_accepted · offer_declined · booking_request · booked · rejection
  key: text('idempotency_key').notNull().unique(), // also the provider's idempotency key
  to: text('to').notNull(),
  replyTo: text('reply_to'),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: createdAt(),
  sentAt: ts('sent_at'),
  attempts: integer('attempts').notNull().default(0), // failed sends so far
  failedAt: ts('failed_at'), // given up: too many attempts or a permanent error; the sweeper skips it
  nodeKey: text('node_key'), // where the application was when queued: the status page shows progress as of the last email sent
}, t => [index('candidate_emails_app_idx').on(t.applicationId, t.seq)])

export const reminderLog = pgTable('reminder_log', {
  runId: uuid('run_id').notNull().references(() => nodeRuns.id),
  userId: text('user_id').notNull().references(() => user.id),
  day: date('day').notNull(),
}, t => [primaryKey({ columns: [t.runId, t.userId, t.day] })])

// ---------- notices (the Updates tray; items are read from application_events) ----------

// Per person: everything up to seen_seq has been looked at (the count starts after it); up to cleared_seq is gone.
export const noticeState = pgTable('notice_state', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  seenSeq: bigint('seen_seq', { mode: 'number' }).notNull().default(0),
  clearedSeq: bigint('cleared_seq', { mode: 'number' }).notNull().default(0),
})

// One item by its head event: opened (read), or dismissed from the tray.
// ponytail: never pruned; delete rows older than the 30-day window if the table grows
export const noticeMarks = pgTable('notice_marks', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  dismissed: boolean('dismissed').notNull().default(false),
}, t => [primaryKey({ columns: [t.userId, t.seq] })])
