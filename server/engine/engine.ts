import { and, desc, eq, inArray, isNull, lt, lte, max, or, sql } from 'drizzle-orm'
import { aggregateScorecard, type HumanTaskConfig, normalizeOutput, REGISTRY, runSetVariable, scorecardSchema } from '../../shared/workflow/registry'
import { type ConditionConfig, pickBranch } from '../../shared/workflow/rules'
import { render } from '../../shared/workflow/template'
import type { Context, FormField, Graph, GraphNode } from '../../shared/workflow/types'
import type { Db, Tx } from '../db/client'
import { applicationEvents, applications, jobs, jobVersions, nodeRuns, roles, taskAssignments, user } from '../db/schema'
import { accessLevel } from '../domain/access'
import { DomainError } from '../domain/errors'
import { ZodError } from 'zod'
import { buildContext } from './context'

// State lives in node_runs. Every state change is one transaction; queue sends happen after commit.
// The partial unique index node_runs_one_active_uq guarantees at most one active run per application.

export type Run = typeof nodeRuns.$inferSelect
export type Application = typeof applications.$inferSelect
export type Outcome = 'hired' | 'rejected' | 'withdrawn'

export interface Enqueued { runId: string, delaySeconds?: number }

export interface AutoHandlerArgs {
  run: Run
  node: GraphNode
  config: any
  ctx: Context
  form: FormField[] // the pinned form definition (labels, protected and file flags)
  application: Application
}
// Returns the node's output (and optionally an audit `input`, e.g. hashes of what was sent to the AI).
export type AutoHandler = (args: AutoHandlerArgs) => Promise<{ output: Record<string, unknown>, input?: unknown }>

export class HandlerError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, detail?: string) { super(detail ? `${code}: ${detail}` : code) }
}

export interface EngineDeps {
  db: Db
  enqueue: (items: Enqueued[]) => Promise<void>
  handlers: Record<string, AutoHandler>
  adminEmail: string
  disabledTypes?: Set<string>
  now?: () => Date
}

export const MAX_RETRIES = 3
const BACKOFF_SECONDS = [30, 120, 600]
export const STALE_RUNNING_MS = 15 * 60_000 // a queue consumer can't run longer than this
export const LOST_PENDING_MS = 2 * 60_000
const ACTIVE = ['pending', 'running', 'waiting_on_human'] as const
const STEP_CAP = 100

const now = (deps: EngineDeps) => deps.now?.() ?? new Date()

// After commit only. A lost send is recovered by the sweeper, so failures here are logged, not thrown.
async function flush(deps: EngineDeps, out: Enqueued[]) {
  if (!out.length) return
  try {
    await deps.enqueue(out)
  }
  catch (e) {
    console.error('[engine] enqueue failed; sweeper will retry', e)
  }
}

async function event(tx: Tx, applicationId: string, type: string, data: Record<string, unknown> = {}, actorId?: string | null) {
  await tx.insert(applicationEvents).values({ applicationId, type, data, actorId: actorId ?? null })
}

async function lockApplication(tx: Tx, applicationId: string) {
  const [app] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for('update')
  if (!app) throw new DomainError(404, 'application_not_found')
  return app
}

async function loadVersion(tx: Db | Tx, jobVersionId: string) {
  const [v] = await tx.select({ workflow: jobVersions.workflow, form: jobVersions.form }).from(jobVersions).where(eq(jobVersions.id, jobVersionId))
  return { graph: v!.workflow as Graph, form: v!.form as FormField[] }
}
const loadGraph = async (tx: Db | Tx, jobVersionId: string) => (await loadVersion(tx, jobVersionId)).graph

const findNode = (graph: Graph, key: string) => {
  const node = graph.nodes.find(n => n.key === key)
  if (!node) throw new DomainError(422, 'node_not_in_version')
  return node
}

const configOf = (node: GraphNode) => REGISTRY[node.type]!.config.parse(node.config ?? {})

const successor = (graph: Graph, key: string, branch?: string) =>
  graph.edges.find(e => e.from === key && (branch === undefined || e.branch === branch))?.to

async function nextAttempt(tx: Tx, applicationId: string, nodeKey: string) {
  const [{ n }] = await tx.select({ n: max(nodeRuns.attempt) }).from(nodeRuns)
    .where(and(eq(nodeRuns.applicationId, applicationId), eq(nodeRuns.nodeKey, nodeKey))) as [{ n: number | null }]
  return (n ?? 0) + 1
}

interface Walk { tx: Tx, deps: EngineDeps, app: Application, graph: Graph, ctx: Context, out: Enqueued[], actorId?: string | null }

// Activates `nodeKey` and keeps walking through instant nodes until it reaches an auto node
// (pending + enqueue), a human task (waiting), an End (closes the application) or a failure.
async function activate(w: Walk, nodeKey: string) {
  const { tx, deps, app } = w
  let key: string | undefined = nodeKey
  for (let step = 0; key; step++) {
    if (step >= STEP_CAP) throw new Error(`engine: step cap hit at ${key}`) // validation forbids cycles; this is a guard
    const node = findNode(w.graph, key)
    const def = REGISTRY[node.type]!
    const config = configOf(node)
    const attempt = await nextAttempt(tx, app.id, key)
    const t = now(deps)
    const base = { applicationId: app.id, nodeKey: key, nodeType: node.type, attempt, actorId: w.actorId ?? null }
    await tx.update(applications).set({ currentNodeKey: key }).where(eq(applications.id, app.id))

    if (def.kind === 'trigger') {
      await tx.insert(nodeRuns).values({ ...base, status: 'completed', output: {}, completedAt: t })
      key = successor(w.graph, key)
    }
    else if (node.type === 'set_variable') {
      const output = runSetVariable(config, w.ctx)
      await tx.insert(nodeRuns).values({ ...base, status: 'completed', output, completedAt: t })
      w.ctx.nodes[key] = output
      key = successor(w.graph, key)
    }
    else if (node.type === 'condition') {
      const evaluation = pickBranch(config as ConditionConfig, w.ctx)
      await tx.insert(nodeRuns).values({ ...base, status: 'completed', output: {}, branchTaken: evaluation.branch, evaluation, completedAt: t })
      w.ctx.nodes[key] = {}
      key = successor(w.graph, key, evaluation.branch)
    }
    else if (def.kind === 'terminal') {
      const outcome = (config as { outcome: Outcome }).outcome
      await tx.insert(nodeRuns).values({ ...base, status: 'completed', output: { outcome }, completedAt: t })
      await tx.update(applications).set({ status: 'closed', outcome }).where(eq(applications.id, app.id))
      await event(tx, app.id, 'closed', { outcome, node: key }, w.actorId)
      return
    }
    else if (def.kind === 'auto') {
      const [run] = await tx.insert(nodeRuns).values({ ...base, status: 'pending', nextAttemptAt: t }).returning()
      w.out.push({ runId: run!.id })
      return
    }
    else {
      await activateHumanTask(w, node, config as HumanTaskConfig, base, t)
      return
    }
  }
}

async function activateHumanTask(w: Walk, node: GraphNode, config: HumanTaskConfig, base: Omit<typeof nodeRuns.$inferInsert, 'status'>, t: Date) {
  const { tx, app } = w
  const assignees = await resolveAssignees(tx, w.deps.adminEmail, app.jobId, config.assignees)
  if (assignees.length < config.min_submissions) {
    await tx.insert(nodeRuns).values({ ...base, status: 'failed', error: 'no_assignees', completedAt: t })
    await event(tx, app.id, 'run_failed', { node: node.key, error: 'no_assignees', found: assignees.length, needed: config.min_submissions })
    return
  }
  const dueAt = config.due_days !== undefined ? new Date(t.getTime() + config.due_days * 86_400_000) : null
  const title = render(config.title, w.ctx)
  const instructions = config.instructions ? render(config.instructions, w.ctx) : undefined
  const [run] = await tx.insert(nodeRuns).values({ ...base, status: 'waiting_on_human', dueAt, input: { title, instructions } }).returning()
  await tx.insert(taskAssignments).values(assignees.map(userId => ({ runId: run!.id, userId })))
  await event(tx, app.id, 'task_assigned', { node: node.key, runId: run!.id, assignees })
}

// Specific users ∪ active members of the roles ∪ the job owner; only people who can still sign in.
export async function resolveAssignees(tx: Db | Tx, adminEmail: string, jobId: string, a: HumanTaskConfig['assignees']) {
  const [job] = await tx.select({ ownerId: jobs.ownerId }).from(jobs).where(eq(jobs.id, jobId))
  const ids = [...a.users, ...(a.job_owner ? [job!.ownerId] : [])]
  const conds = [ids.length ? inArray(user.id, ids) : undefined, a.roles.length ? inArray(user.roleId, a.roles) : undefined].filter(Boolean)
  if (!conds.length) return []
  const rows = await tx.select({ id: user.id, email: user.email, active: user.active, level: roles.level })
    .from(user).leftJoin(roles, eq(roles.id, user.roleId)).where(or(...conds))
  return [...new Set(rows.filter(u => accessLevel(u, u.level, adminEmail)).map(u => u.id))].sort()
}

async function walkFrom(tx: Tx, deps: EngineDeps, app: Application, nodeKey: string, out: Enqueued[], actorId?: string | null) {
  const graph = await loadGraph(tx, app.jobVersionId)
  const ctx = await buildContext(tx, app.id)
  await activate({ tx, deps, app, graph, ctx, out, actorId }, nodeKey)
}

// ---------- entry points ----------

// Called right after the application row is committed. Idempotent: a second call does nothing.
export async function startApplication(deps: EngineDeps, applicationId: string) {
  const out: Enqueued[] = []
  await deps.db.transaction(async (tx) => {
    const app = await lockApplication(tx, applicationId)
    const [any] = await tx.select({ id: nodeRuns.id }).from(nodeRuns).where(eq(nodeRuns.applicationId, app.id)).limit(1)
    if (any) return
    const graph = await loadGraph(tx, app.jobVersionId)
    const trigger = graph.nodes.find(n => REGISTRY[n.type]?.kind === 'trigger')!
    await event(tx, app.id, 'application_submitted', { jobVersionId: app.jobVersionId })
    await activate({ tx, deps, app, graph, ctx: await buildContext(tx, app.id), out }, trigger.key)
  })
  await flush(deps, out)
}

export type ExecuteResult = 'completed' | 'retrying' | 'failed' | 'cancelled' | 'noop' | 'stale'

// Queue consumer entry. Safe under duplicate delivery: only the claim winner runs the handler.
export async function executeAutoRun(deps: EngineDeps, runId: string): Promise<ExecuteResult> {
  const { db } = deps
  const claimedAt = now(deps)
  const [run] = await db.update(nodeRuns).set({ status: 'running', claimedAt })
    .where(and(eq(nodeRuns.id, runId), eq(nodeRuns.status, 'pending'), or(isNull(nodeRuns.nextAttemptAt), lte(nodeRuns.nextAttemptAt, claimedAt))))
    .returning()
  if (!run) return 'noop'

  const fenced = and(eq(nodeRuns.id, run.id), eq(nodeRuns.status, 'running'), eq(nodeRuns.claimedAt, claimedAt))
  const [application] = await db.select().from(applications).where(eq(applications.id, run.applicationId))
  if (application!.status !== 'active') {
    await db.update(nodeRuns).set({ status: 'cancelled', completedAt: now(deps), error: 'application_closed' }).where(fenced)
    return 'cancelled'
  }
  if (deps.disabledTypes?.has(run.nodeType)) return recordFailure(deps, run, claimedAt, new HandlerError('disabled', false))

  let result: Awaited<ReturnType<AutoHandler>>
  try {
    const { graph, form } = await loadVersion(db, application!.jobVersionId)
    const node = findNode(graph, run.nodeKey)
    const handler = deps.handlers[run.nodeType]
    if (!handler) throw new HandlerError('no_handler', false, run.nodeType)
    const config = configOf(node)
    result = await handler({ run, node, config, form, ctx: await buildContext(db, run.applicationId), application: application! })
    result = { ...result, output: normalizeOutput(REGISTRY[node.type]!.outputs(config), result.output) }
  }
  catch (e) {
    return recordFailure(deps, run, claimedAt, e)
  }

  const out: Enqueued[] = []
  const status = await db.transaction(async (tx) => {
    const app = await lockApplication(tx, run.applicationId) // serialises with manual moves and submissions
    const [done] = await tx.update(nodeRuns)
      .set({ status: 'completed', output: result.output, input: result.input ?? null, completedAt: now(deps), error: null })
      .where(fenced).returning()
    if (!done) return 'stale' as const // cancelled by a move, or recovered by the sweeper and claimed again
    if (app.status !== 'active') return 'completed' as const
    const graph = await loadGraph(tx, app.jobVersionId)
    const next = successor(graph, run.nodeKey)
    if (next) await walkFrom(tx, deps, app, next, out)
    return 'completed' as const
  })
  await flush(deps, out)
  return status
}

async function recordFailure(deps: EngineDeps, run: Run, claimedAt: Date, e: unknown): Promise<ExecuteResult> {
  const err = e instanceof HandlerError ? e
    : e instanceof ZodError ? new HandlerError('invalid_config', false, e.message) // a node config that no longer parses
      : new HandlerError('error', true, e instanceof Error ? e.message : String(e))
  const fenced = and(eq(nodeRuns.id, run.id), eq(nodeRuns.status, 'running'), eq(nodeRuns.claimedAt, claimedAt))
  const t = now(deps)
  if (err.retryable && run.retries < MAX_RETRIES) {
    const delaySeconds = BACKOFF_SECONDS[run.retries]!
    const [updated] = await deps.db.update(nodeRuns).set({
      status: 'pending', retries: run.retries + 1, error: err.message, claimedAt: null,
      nextAttemptAt: new Date(t.getTime() + delaySeconds * 1000),
    }).where(fenced).returning()
    if (!updated) return 'stale'
    await flush(deps, [{ runId: run.id, delaySeconds }])
    return 'retrying'
  }
  const failed = await deps.db.transaction(async (tx) => {
    const [updated] = await tx.update(nodeRuns).set({ status: 'failed', error: err.message, completedAt: t }).where(fenced).returning()
    if (updated) await event(tx, run.applicationId, 'run_failed', { node: run.nodeKey, runId: run.id, error: err.message, retries: run.retries })
    return !!updated
  })
  return failed ? 'failed' : 'stale'
}

// One assignee's scorecard. Completes the task once min_submissions is reached.
export async function submitTask(deps: EngineDeps, runId: string, userId: string, values: unknown) {
  const out: Enqueued[] = []
  const result = await deps.db.transaction(async (tx) => {
    const [r] = await tx.select({ applicationId: nodeRuns.applicationId }).from(nodeRuns).where(eq(nodeRuns.id, runId))
    if (!r) throw new DomainError(404, 'task_not_found')
    const app = await lockApplication(tx, r.applicationId)
    const [run] = await tx.select().from(nodeRuns).where(eq(nodeRuns.id, runId))
    const [assignment] = await tx.select().from(taskAssignments)
      .where(and(eq(taskAssignments.runId, runId), eq(taskAssignments.userId, userId)))
    if (!assignment) throw new DomainError(404, 'task_not_found')
    if (assignment.submittedAt) throw new DomainError(409, 'already_submitted')
    if (run!.status !== 'waiting_on_human' || assignment.closedAt) throw new DomainError(409, 'task_closed')

    const graph = await loadGraph(tx, app.jobVersionId)
    const config = configOf(findNode(graph, run!.nodeKey)) as HumanTaskConfig
    const parsed = scorecardSchema(config.scorecard).safeParse(values)
    if (!parsed.success) {
      throw new DomainError(422, 'invalid_scorecard', parsed.error.issues.map(i => ({ code: 'invalid_value', message: `${i.path.join('.')}: ${i.message}` })))
    }
    const t = now(deps)
    await tx.update(taskAssignments).set({ submittedAt: t, values: parsed.data })
      .where(and(eq(taskAssignments.runId, runId), eq(taskAssignments.userId, userId)))
    await event(tx, app.id, 'task_submitted', { node: run!.nodeKey, runId }, userId)

    const submitted = await tx.select({ values: taskAssignments.values }).from(taskAssignments)
      .where(and(eq(taskAssignments.runId, runId), sql`${taskAssignments.submittedAt} is not null`))
    if (submitted.length < config.min_submissions) return { completed: false }

    const output = aggregateScorecard(config.scorecard, submitted.map(s => s.values as Record<string, unknown>))
    await tx.update(nodeRuns).set({ status: 'completed', output, completedAt: t }).where(eq(nodeRuns.id, runId))
    await tx.update(taskAssignments).set({ closedAt: t }).where(and(eq(taskAssignments.runId, runId), isNull(taskAssignments.closedAt)))
    const next = successor(graph, run!.nodeKey)
    if (next) await walkFrom(tx, deps, app, next, out)
    return { completed: true }
  })
  await flush(deps, out)
  return result
}

// Add or remove assignees on a waiting task. Submissions already made are kept.
export async function reassignTask(deps: EngineDeps, runId: string, change: { add: string[], remove: string[] }, actorId: string) {
  return deps.db.transaction(async (tx) => {
    const [r] = await tx.select({ applicationId: nodeRuns.applicationId }).from(nodeRuns).where(eq(nodeRuns.id, runId))
    if (!r) throw new DomainError(404, 'task_not_found')
    const app = await lockApplication(tx, r.applicationId)
    const [run] = await tx.select().from(nodeRuns).where(eq(nodeRuns.id, runId))
    if (run!.status !== 'waiting_on_human') throw new DomainError(409, 'task_closed')

    if (change.add.length) {
      const usable = await resolveAssignees(tx, deps.adminEmail, app.jobId, { users: change.add, roles: [], job_owner: false })
      const bad = change.add.filter(id => !usable.includes(id))
      if (bad.length) throw new DomainError(422, 'bad_assignee', bad.map(id => ({ code: 'bad_assignee', message: `${id} cannot be assigned` })))
      // re-adding someone who was removed reopens their assignment
      await tx.insert(taskAssignments).values(usable.map(userId => ({ runId, userId })))
        .onConflictDoUpdate({ target: [taskAssignments.runId, taskAssignments.userId], set: { closedAt: null }, setWhere: isNull(taskAssignments.submittedAt) })
    }
    const removed = change.remove.length
      ? (await tx.update(taskAssignments).set({ closedAt: now(deps) })
          .where(and(eq(taskAssignments.runId, runId), inArray(taskAssignments.userId, change.remove), isNull(taskAssignments.submittedAt), isNull(taskAssignments.closedAt)))
          .returning({ userId: taskAssignments.userId })).map(r => r.userId)
      : []
    if (removed.length) {
      // a removal may not strand the task: submissions plus open assignees who can sign in must still reach the minimum
      const config = configOf(findNode(await loadGraph(tx, app.jobVersionId), run!.nodeKey)) as HumanTaskConfig
      const rows = await tx.select({ submittedAt: taskAssignments.submittedAt, closedAt: taskAssignments.closedAt, email: user.email, active: user.active, level: roles.level })
        .from(taskAssignments).innerJoin(user, eq(user.id, taskAssignments.userId)).leftJoin(roles, eq(roles.id, user.roleId))
        .where(eq(taskAssignments.runId, runId))
      const reachable = rows.filter(r => r.submittedAt || (!r.closedAt && accessLevel(r, r.level, deps.adminEmail))).length
      if (reachable < config.min_submissions) throw new DomainError(422, 'below_min_submissions')
    }
    await event(tx, app.id, 'task_reassigned', { runId, add: change.add, remove: removed }, actorId)
    return tx.select().from(taskAssignments).where(eq(taskAssignments.runId, runId))
  })
}

export type MoveTarget = { node: string } | { close: Outcome }
// Where the mover saw the application. A board shows a snapshot; by the time a move lands the candidate
// may have moved on by itself, and then the move is skipped rather than yanking them back.
export type MoveFrom = { node: string } | { closed: Outcome }
export interface MoveResult { moved: boolean, currentNodeKey: string | null, status: 'active' | 'closed', outcome: Outcome | null }

const isAt = (app: Application, from: MoveFrom) => 'node' in from
  ? app.status === 'active' && app.currentNodeKey === from.node
  : app.status === 'closed' && app.outcome === from.closed

// Manual override: cancel whatever is active, then jump to any node (or close). Also reopens.
export async function moveApplication(deps: EngineDeps, applicationId: string, target: MoveTarget, reason: string, actorId: string, from?: MoveFrom): Promise<MoveResult> {
  const out: Enqueued[] = []
  const moved = await deps.db.transaction(async (tx) => {
    const app = await lockApplication(tx, applicationId)
    if (from && !isAt(app, from)) return false
    const graph = await loadGraph(tx, app.jobVersionId)
    if ('node' in target) findNode(graph, target.node) // 422 before changing anything
    // changing a recorded outcome goes through a reopen, so a hire can't flip with a single call
    else if (app.status === 'closed') throw new DomainError(409, 'already_closed')

    const t = now(deps)
    const cancelled = await tx.update(nodeRuns).set({ status: 'cancelled', completedAt: t, error: 'manual_move' })
      .where(and(eq(nodeRuns.applicationId, app.id), inArray(nodeRuns.status, [...ACTIVE]))).returning({ id: nodeRuns.id, nodeKey: nodeRuns.nodeKey })
    if (cancelled.length) {
      await tx.update(taskAssignments).set({ closedAt: t })
        .where(and(inArray(taskAssignments.runId, cancelled.map(c => c.id)), isNull(taskAssignments.closedAt)))
    }
    await event(tx, app.id, 'manual_move', {
      reason, to: target,
      previous: { status: app.status, outcome: app.outcome, node: app.currentNodeKey, cancelledRuns: cancelled.map(c => c.id) },
    }, actorId)

    if ('close' in target) {
      await tx.update(applications).set({ status: 'closed', outcome: target.close }).where(eq(applications.id, app.id))
      await event(tx, app.id, 'closed', { outcome: target.close, manual: true }, actorId)
      return true
    }
    if (app.status === 'closed') {
      await tx.update(applications).set({ status: 'active', outcome: null }).where(eq(applications.id, app.id))
      await event(tx, app.id, 'reopened', { reason }, actorId)
    }
    await walkFrom(tx, deps, { ...app, status: 'active', outcome: null }, target.node, out, actorId)
    return true
  })
  await flush(deps, out)
  // the walk may carry on past the target (a condition, an End), so report where it actually stopped
  const [pos] = await deps.db.select({ currentNodeKey: applications.currentNodeKey, status: applications.status, outcome: applications.outcome })
    .from(applications).where(eq(applications.id, applicationId))
  return { moved, ...pos! } as MoveResult
}

// Retry the application's latest run when it failed, or when it is stuck in `running` (dead worker).
export async function retryRun(deps: EngineDeps, runId: string, actorId: string) {
  const out: Enqueued[] = []
  await deps.db.transaction(async (tx) => {
    const [r] = await tx.select({ applicationId: nodeRuns.applicationId }).from(nodeRuns).where(eq(nodeRuns.id, runId))
    if (!r) throw new DomainError(404, 'run_not_found')
    const app = await lockApplication(tx, r.applicationId)
    if (app.status !== 'active') throw new DomainError(409, 'application_closed')
    const [latest] = await tx.select().from(nodeRuns).where(eq(nodeRuns.applicationId, app.id))
      .orderBy(desc(nodeRuns.seq)).limit(1)
    if (latest!.id !== runId) throw new DomainError(409, 'not_latest_run')
    const stale = latest!.status === 'running' && latest!.claimedAt!.getTime() < now(deps).getTime() - STALE_RUNNING_MS
    if (latest!.status !== 'failed' && !stale) throw new DomainError(409, 'not_retryable')
    if (stale) await tx.update(nodeRuns).set({ status: 'failed', error: 'stale_running', completedAt: now(deps) }).where(eq(nodeRuns.id, runId))
    await event(tx, app.id, 'run_retried', { node: latest!.nodeKey, runId }, actorId)
    await walkFrom(tx, deps, app, latest!.nodeKey, out, actorId)
  })
  await flush(deps, out)
}

// Cron, every 5 minutes. Re-sends lost messages and recovers runs whose worker died.
export async function sweep(deps: EngineDeps) {
  const t = now(deps).getTime()
  const lost = await deps.db.select({ id: nodeRuns.id }).from(nodeRuns)
    .where(and(eq(nodeRuns.status, 'pending'), lt(nodeRuns.nextAttemptAt, new Date(t - LOST_PENDING_MS)))).limit(500)
  await flush(deps, lost.map(r => ({ runId: r.id })))

  const dead = await deps.db.select().from(nodeRuns)
    .where(and(eq(nodeRuns.status, 'running'), lt(nodeRuns.claimedAt, new Date(t - STALE_RUNNING_MS)))).limit(500)
  // one bad row must not stop the rest; each failure is logged and the next sweep tries again
  const each = async <T>(rows: T[], fn: (row: T) => Promise<unknown>) => {
    for (const row of rows) await fn(row).catch(e => console.error('[engine] sweep item failed', row, e))
  }
  await each(dead, run => recordFailure(deps, run, run.claimedAt!, new HandlerError('worker_lost', true)))

  // applications committed but never started (the apply request died after its commit)
  const unstarted = await deps.db.select({ id: applications.id }).from(applications)
    .where(and(eq(applications.status, 'active'), lt(applications.createdAt, new Date(t - LOST_PENDING_MS)),
      sql`not exists (select 1 from ${nodeRuns} r where r.application_id = ${applications.id})`)).limit(500)
  await each(unstarted, a => startApplication(deps, a.id))
  return { requeued: lost.length, recovered: dead.length, started: unstarted.length }
}
