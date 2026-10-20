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
}, t => [check('settings_single_row', sql`${t.id} = 1`)])

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
}, t => [index('application_events_app_idx').on(t.applicationId, t.seq)])

export const reminderLog = pgTable('reminder_log', {
  runId: uuid('run_id').notNull().references(() => nodeRuns.id),
  userId: text('user_id').notNull().references(() => user.id),
  day: date('day').notNull(),
}, t => [primaryKey({ columns: [t.runId, t.userId, t.day] })])
