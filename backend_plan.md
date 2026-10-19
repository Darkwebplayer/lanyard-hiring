# Backend Plan

Status: draft · 2026-10-19
Builds on: `final_mvp_reference.md` (the reference). This file records only where the plan **differs** from the reference and how the backend gets built. Everything not mentioned here follows the reference.

---

## 1. Decisions that change the reference

| Topic | Reference | This plan | Why |
|---|---|---|---|
| Tenancy | Multi-tenant, `tenant_id` everywhere | **Single company per deployment.** No `tenant_id`, no isolation helper, no isolation tests | One company, one admin from env. Removes a whole layer. Going multi-tenant later is a migration (add `org_id`) plus a query audit |
| Auth | Email and password, invite links | **Google sign-in only** (Better Auth social provider). **Invite-only**: an un-invited Google account is refused | The user asked for it |
| Admin | `admin` role in the DB | **Admin = `ADMIN_EMAIL` env var**, checked on every request, never stored | Admin can't be locked out or demoted through the UI |
| Roles | `admin` / `recruiter` enum | **Named roles** (`roles.name` is free text, e.g. "Tech Lead") that each map to one **level**: `manager` or `employee` | Names are up to the company. Permissions come only from the level |
| Versions | `form_versions` + `workflow_versions` | **One `job_versions` table** that holds both `form` and `workflow` JSON | They always publish together, so one row and one pin per application |
| Assignments | `task_assignments` + `task_submissions` | **One `task_assignments` table** with `submitted_at` and `values` | One row per (run, user) either way |
| Task assignees | Specific users or the job owner | Adds **"everyone with role X"** | That's what named roles are for, e.g. "any Tech Interviewer" |
| Stuck work | No sweeper; stale runs only show in the inbox | **A 5-minute cron sweeper** re-enqueues lost messages and recovers dead claims | Without it, a message lost between commit and enqueue leaves a candidate stuck with no signal (section 6.3) |
| Queues | CV / AI / email queues + DLQ | **One queue** (`{ runId }`), dispatched by node type. No DLQ | The sweeper already catches anything a DLQ would. Split queues only if concurrency needs differ |
| Email | Resend | **`sendEmail(env, idempotencyKey, email)` is mocked for this build.** It logs, and dedupes by key the way a provider would. Cloudflare Email Service has no idempotency key, so a real send will use Resend | The idempotency key is required, so the mock already enforces it |
| AI | `callLLM(schema, input)` | The same function built on **AI SDK `generateObject`** with a Zod schema. Provider chosen later | The user asked for AI SDK |

Not adopted: Cloudflare Workflows or Durable Objects as the engine. Manual move to any node, reopen, retry of one step, and version pinning all fight a durable-step model. A Postgres state machine plus Queues handles them directly. The engine stays free of Nuxt, so this can be revisited later.

---

## 2. Permissions

| Action | Admin | Manager | Employee |
|---|---|---|---|
| Manage roles, invites, deactivate users, settings | ✓ | | |
| Create, edit and publish jobs, forms and workflows | ✓ | ✓ | |
| See all jobs, applications and the pipeline | ✓ | ✓ | |
| Assign or reassign tasks, manual move, reopen, close, retry runs | ✓ | ✓ | |
| Hire report | ✓ | ✓ | |
| See **own** tasks and the applications those tasks belong to | ✓ | ✓ | ✓ |
| Submit a scorecard on an own task | ✓ | ✓ | ✓ |

Rules:
- An employee asking for anything outside their assignments gets **404**, not 403, so ids don't leak.
- Blind panels: an assignee can't see other scorecards on that run until they submit their own. Managers see everything.
- A non-admin user with no role, or an inactive user, has no access. This also covers the case where `ADMIN_EMAIL` changes and the old admin has no role.
- Users are never deleted, only deactivated, because history points at them.

### Sign-in flow
1. The admin (or anyone invited) clicks "Sign in with Google".
2. In Better Auth's `databaseHooks.user.create.before`: lowercase the email; reject if Google says the email is unverified; allow if it equals `ADMIN_EMAIL`; otherwise look up `invites` and copy its `role_id`. If there's no invite, refuse with 403.
3. On every request, the session middleware loads the user, refuses if they're inactive, and computes `isAdmin` and `level`.
4. Deactivating a user sets `active=false` and deletes their sessions.

---

## 3. Stack and bindings

| Concern | Choice |
|---|---|
| App | Nuxt 4, Nitro `cloudflare_module` preset |
| DB | Postgres (Neon) through Hyperdrive, Drizzle with the `postgres` driver. Create **one client per request** (Workers can't reuse sockets across requests) |
| Auth | Better Auth, Drizzle adapter, Google provider |
| Files | R2 `CV_BUCKET`, key `jobs/<jobId>/<applicationId>/<uuid>`, written once |
| Async | One Queue `ENGINE`. Consumer through a **custom Worker entry** (`server/entry.ts`), not the Nitro hook: Nitro's `cloudflare:queue` hook runs inside `waitUntil` and returns at once, so the batch is acked before the work finishes. Messages are only triggers and **Postgres is the source of truth**: each message is acked after handling, and a retry is a new delayed `send` |
| Cron | `*/5 * * * *` sweeper, `0 8 * * *` reminders, through the same entry's `scheduled` (switch on `cron`) |
| AI | AI SDK `generateObject` |
| Bot protection | Turnstile |
| Tests | Vitest. Pure units for `shared/`; integration tests for the engine against real Postgres (local Docker or a Neon branch), with the queue injected as a function |

Env: `ADMIN_EMAIL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SECRET`, `DISABLED_NODE_TYPES`, `AI_*`, `EMAIL_*`, `APP_FROM_EMAIL`.

### Layout
```
shared/workflow/     pure TS: types, node registry, rules, templates, field catalog, graph validation, form → zod
server/db/           schema.ts, client.ts, migrations/
server/engine/       start, walk, execute, tasks, move, sweep, handlers/*  (no Nuxt imports)
server/domain/       jobs, publish, apply
server/api/          thin routes: validate → auth guard → domain/engine
server/plugins/      queue.ts, scheduled.ts
server/utils/        auth.ts, guards.ts (requireUser / requireManager / requireAdmin)
```

---

## 4. Data model

```
user, session, account, verification   Better Auth tables. user gets: role_id (nullable), active
roles            id, name unique, level enum(manager|employee)
invites          email pk (lowercase), role_id, invited_by, created_at
settings         single row: reply_to_email, consent_text, ai_notice_text

jobs             id, title, description, requirements jsonb, openings int, status(draft|open|closed|archived),
                 closes_at, owner_id, published_version_id
job_versions     id, job_id, version int, status(draft|published), form jsonb, workflow jsonb, published_at
                 unique(job_id, version); unique(job_id) where status='draft'   -- at most one draft per job

candidates       id, email unique (lowercase), first_name, last_name, phone
applications     id, job_id, candidate_id, job_version_id (the pin), answers jsonb,
                 status(active|closed), outcome(hired|rejected|withdrawn|null), current_node_key, created_at
                 unique(job_id, candidate_id)

node_runs        id, application_id, node_key, node_type, attempt,
                 status(pending|running|waiting_on_human|completed|failed|cancelled),
                 input jsonb, output jsonb, branch_taken, evaluation jsonb, error,
                 retries, next_attempt_at, claimed_at, due_at, actor_id, created_at, completed_at
                 unique(application_id, node_key, attempt)
                 unique(application_id) where status in (pending, running, waiting_on_human)   -- ONE active run

task_assignments run_id, user_id, assigned_at, submitted_at, values jsonb, closed_at
                 pk(run_id, user_id)
application_events id, application_id, type, actor_id, data jsonb, created_at   -- append-only
reminder_log     run_id, user_id, day date, pk(run_id, user_id, day)
```

Constraints worth the most:
- **One active run per application** (partial unique index). The MVP has no parallel branches, so this is always true. The database enforces it, so a race that would double-activate fails inside the transaction instead of corrupting state.
- **One draft per job** and **one application per candidate per job** are also indexes, not app code.

---

## 5. Shared workflow core (`shared/workflow/`)

Pure and synchronous, with no I/O. The canvas uses it later too, so its types are the contract with the frontend.

- **Types**: `Graph { nodes: Node[], edges: Edge[] }`, `Node { key, type, config, position }`, `Edge { from, to, branch? }`, `FieldType`.
- **Registry**: per node type, a `configSchema` (Zod), `outputSchema(config) → Field[]`, and `kind` (`instant | auto | human | terminal`). Runtime handlers are attached on the server, keyed by type, so `shared/` stays free of I/O.
- **Field catalog** `fieldsAvailableAt(graph, nodeKey, form, job)`: `candidate.*`, `form.*`, `job.*`, plus the outputs of nodes on **every** path to this node. The picker endpoint and ref validation both use it.
- **Rule evaluator** `evaluate(rule, ctx) → { result, trace }`: `all/any/not`, operators filtered by type, and missing values compare as false. Returns a trace, which becomes the stored evaluation snapshot.
- **Condition** `pickBranch(config, ctx)`: if any referenced field is missing and `on_missing_branch` is set, take that branch. Otherwise the first match wins, then `default`.
- **Templates** `render(tpl, ctx, { strict })` and `refsIn(tpl)`. Strict mode throws on a missing ref (used for emails).
- **Graph validation** `validate(graph, form, job) → Issue[]` with every rule from reference §7. Issues are tied to a node key, so the canvas can mark broken nodes.
- **Form → Zod** `formSchema(form)`: types, required, min/max/options. Empty counts as absent.
- **Scorecard aggregation**: numbers are averaged; booleans give `field` (all agreed) and `field_any` (at least one); text is joined.
- Fixture: the **"Standard hire"** template JSON. It must validate cleanly.

---

## 6. Engine (`server/engine/`): all the cases

### 6.1 Core functions
| Function | Does |
|---|---|
| `startApplication(tx, appId)` | Creates the trigger run, completes it, calls `activate(successor)` |
| `activate(tx, appId, nodeKey)` | Creates run attempt N+1 for that node. **instant**: evaluate, complete, recurse to the next node. **auto**: create a `pending` run and add `runId` to the post-commit enqueue list. **human**: resolve assignees, create a `waiting_on_human` run, assignments, `due_at` and a `task_assigned` event. **end**: set `applications.status=closed` and `outcome` |
| `executeAutoRun(runId)` | Claim → handler → complete, or record the failure (6.2) |
| `submitTask(runId, userId, values)` | Validates values against the scorecard and stores the submission. Once `min_submissions` is reached: aggregate, complete, close the other assignments, activate the successor |
| `moveApplication(appId, target, reason, actor)` | `target = { node } \| { close: outcome }`. Cancels the active run, writes a `manual_move` event with the previous state, then activates the target or closes the application. Also reopens closed applications |
| `retryRun(runId, actor)` | Only allowed when the application has no active run and this is its latest run. Creates attempt N+1 for the same node |
| `sweep()` | Section 6.3 |

Every state change runs **in one transaction**, and queue sends happen **after commit**. Instant-node recursion has a step cap of 100 as a guard, even though validation forbids cycles.

### 6.2 Auto-run execution
1. **Claim**: `UPDATE node_runs SET status='running', claimed_at=now() WHERE id=$1 AND status='pending' RETURNING *`. Zero rows means a duplicate or stale message, so ack it and do nothing.
2. If the application is `closed`, the run is cancelled. Ack.
3. If the type is in `DISABLED_NODE_TYPES`, the run fails with `disabled` (non-retryable).
4. Build the context, then run the handler outside any transaction.
5. **Complete**: `UPDATE ... SET status='completed', output=... WHERE id=$1 AND status='running' AND claimed_at=$claimed`. `claimed_at` is the fencing token: if the sweeper recovered the run and another worker claimed it, this worker's late write affects zero rows and is dropped. In the same transaction, activate the successor.
6. **Failure**:
   - Retryable (network, provider 5xx, malformed AI output): if `retries < 3`, set the run back to `pending` with `retries+1` and `next_attempt_at = now + 30s/2m/10m`, and re-enqueue with that delay. Otherwise set `failed` and log a `run_failed` event.
   - Non-retryable (`disabled`, `no_assignees`, `missing_ref`, `unreadable_cv`, `invalid_config`): set `failed` immediately.

### 6.3 Sweeper (every 5 min)
- `pending` with `next_attempt_at < now() - 2 min`: the message was lost (crash between commit and enqueue, or a queue hiccup). Re-enqueue it. This is always safe because claims are idempotent.
- `running` with `claimed_at < now() - 15 min`: the worker died (a queue consumer is capped at 15 min of wall time). Treat it as a retryable failure: back to `pending` with `retries+1`, or `failed` if retries are used up.
- It never touches `waiting_on_human`. Humans aren't on a timer.

### 6.4 Case list (each needs a test)

**Normal flow**
1. Linear happy path: trigger → CV → AI → condition → interview → condition → email → End(hired).
2. Rejection path through the AI-score branch. The stored `evaluation` explains it.
3. Missing data: the AI or CV field is absent, so the flow takes `on_missing_branch` to a manual review task.
4. No branch matches, so the flow takes `default`.
5. A chain of instant nodes (set variable → condition → end) runs inside one transaction with no queue hop.

**Delivery and concurrency**
6. A duplicate queue message: the second claim affects 0 rows, so nothing happens.
7. Two consumers claim at once: exactly one wins.
8. The handler succeeds but the commit fails: the message is redelivered and the handler runs again. Email is safe because the idempotency key is `runId`. The AI simply runs again.
9. A crash after commit, before enqueue: the sweeper re-enqueues.
10. A crash after the claim: the sweeper recovers it after 15 min, and the fencing token drops the dead worker's late write.
11. Something tries to activate a second run: the partial unique index rejects it and the transaction rolls back.

**Failures**
12. A retryable error 3 times, then `failed`, an event, and the item appears in the manager inbox.
13. A non-retryable error fails at once with a clear `error` code.
14. Kill switch: a disabled type fails with `disabled`. After it's re-enabled, retry works. Other applications aren't affected.
15. Malformed AI output fails schema validation and counts as retryable.
16. A scanned or unreadable PDF fails with `unreadable_cv` (non-retryable). The manager moves it to manual review.
17. An email template with a ref that resolves to missing (possible after a manual skip): fails with `missing_ref`, so no "Dear ," gets sent.

**Human tasks**
18. A single assignee submits, so the task completes.
19. A panel with `min_submissions=2` and 3 assignees: the third assignee's submission after completion gets 409, and their assignment is closed.
20. The same user submits twice: the second gets 409 (primary key on run and user, guarded by `submitted_at IS NULL`).
21. Assignees resolve to fewer than `min_submissions` at activation: fails with `no_assignees`.
22. An assignee is deactivated mid-task and the minimum can no longer be reached: the task shows as **blocked** for managers, who reassign it.
23. Reassign: add or remove assignees on a waiting run. Submissions already made are kept.
24. Overdue: `due_at < now()` while waiting is computed when read. The flow never moves on its own.
25. Reminders: one per assignee per day (`reminder_log` primary key, insert first, then send). Rerunning the cron never sends twice.
26. A user who isn't assigned submits: 404.
27. Blind panel: until a user submits, `GET` on the task hides the other submissions.

**Manual control**
28. Move to a later node: the active run is cancelled and the target is activated. Refs to skipped nodes resolve as missing.
29. Move during a running auto run: the run is cancelled, and the worker's completion write affects 0 rows. A side effect already sent (an email) can't be undone; the event log shows it.
30. Move during a human task: the run and its assignments are closed, and a later submission gets 409.
31. Close directly (`{ close: 'rejected' | 'withdrawn' }`) without an End node.
32. Reopen a closed application: status goes back to `active`, `outcome` is cleared, and the target node is activated. Reason `appeal` is the appeal record.
33. Retry when the latest run isn't the failed one, or an active run exists: 409.
34. The move target must exist in the **pinned** version, otherwise 422.

**Versions and jobs**
35. Publishing v2 while v1 applications are in flight: they stay on v1 for good. Migrating them to v2 is deferred.
36. Publish fails validation: the draft is kept and the issues come back per node.
37. A job closes or passes `closes_at`: apply is blocked, but in-flight flows continue.
38. A job with applications can't be deleted, only archived.
39. Node keys and form field keys are immutable after publish. Publish rejects a removed field that's still referenced.

**Apply**
40. The same candidate applies to the same job twice: 409 (unique index). The same email on another job reuses the `candidates` row.
41. The email is lowercased before upsert.
42. Turnstile fails: 400, and nothing is written.
43. A file is the wrong type by magic bytes, or over 10 MB: 400.
44. R2 upload succeeds but the DB transaction fails: the R2 object is deleted on a best-effort basis. Orphans are harmless.
45. AI input never includes protected fields, files, name or email. The input builder is a whitelist and has its own test.

---

## 7. API (backend scope)

| Route | Guard |
|---|---|
| `/api/auth/*` (Better Auth) | public |
| `GET /api/me` | user |
| `GET/POST /api/roles`, `PATCH /api/roles/:id` | admin |
| `GET /api/users`, `POST /api/invites`, `DELETE /api/invites/:email`, `PATCH /api/users/:id` (role, active) | admin |
| `GET/PUT /api/settings` | admin |
| `GET/POST /api/jobs`, `GET/PATCH /api/jobs/:id` | manager |
| `PUT /api/jobs/:id/draft` (form and workflow, lenient Zod) | manager |
| `GET /api/jobs/:id/fields?node=` (picker) | manager |
| `POST /api/jobs/:id/validate` · `POST /api/jobs/:id/publish` | manager |
| `GET /api/jobs/:id/applications` | manager |
| `GET /api/applications/:id` (timeline) | manager, or an assignee on any of its runs |
| `GET /api/applications/:id/files/:field` (streams from R2) | same as above |
| `POST /api/applications/:id/move` | manager |
| `GET /api/tasks` (mine, plus failed, stuck and blocked for managers) | user |
| `GET /api/tasks/:runId` · `POST /api/tasks/:runId/submit` | assignee |
| `PUT /api/runs/:id/assignees` · `POST /api/runs/:id/retry` | manager |
| `GET /api/reports/hires` | manager |
| `GET /api/public/jobs/:id` · `POST /api/public/jobs/:id/apply` | public, Turnstile |

---

## 8. Phases (backend)

Each phase ends with its "done when" passing in CI, not only working on a laptop.

| # | Phase | Deliverable | Done when |
|---|---|---|---|
| 0 | **Skeleton and spikes** | Nuxt 4 on Workers, `wrangler.jsonc` (Hyperdrive, R2, Queue, 2 crons), Drizzle and the first migration, Vitest. Spikes: Nitro `cloudflare:queue` and `cloudflare:scheduled` hooks; a Drizzle transaction through Hyperdrive; PDF text (`unpdf`) and DOCX text (unzip `word/document.xml`) inside a Worker; email provider idempotency | A deployed route writes a row and enqueues; the consumer receives it; the cron fires; the PDF and DOCX fixtures give text. Any failed spike has its fallback chosen (for example a separate consumer Worker that imports `server/engine/`) |
| 1 | **Auth and users** | Better Auth with Google, the invite gate, admin from env, roles, invites, deactivation, guards, `/api/me` | The admin signs in; an invited user signs in with the right level; an un-invited Google account is refused; an employee calling a manager route gets 403/404; a deactivated user's session dies |
| 2 | **Shared workflow core** | All of section 5, with unit tests | The rule evaluator (including missing data), validation (every rule, with a failing fixture for each), templates, catalog, form→Zod and aggregation are all green. The Standard-hire fixture validates |
| 3 | **Jobs and versions** | Job CRUD, draft save, validate, publish (freezes the version, sets `published_version_id`), editing a published job opens draft N+1, the picker endpoint | Saving a draft, publishing v1, editing to v2 and publishing again leaves v1 untouched |
| 4 | **Engine core** | Section 6.1–6.3, using **fake handlers** for CV, AI and email | Cases 1–13 and 18–35 pass against real Postgres |
| 5 | **Real handlers** | CV parse (text extraction plus an LLM for the structured fields), AI review (`generateObject`, input whitelist, stores `model`, `prompt_version`, `input_sha256`), send email (strict templates, Reply-To, `runId` idempotency), kill switch | Cases 14–17 and 45 pass. One real CV goes through parse and review on a staging deploy |
| 6 | **Public apply** | GET job, multipart POST, Turnstile, magic bytes, sha256, R2, closing date, duplicates | `curl` with a PDF starts a flow on staging. Cases 37 and 40–44 pass |
| 7 | **Tasks and operations** | Tasks list (overdue, failed, stuck, blocked), submit, reassign, retry, move, reopen, close, timeline, pipeline, hire report, reminder cron, sweeper cron | Two users finish a panel and the flow continues; an overdue task sends exactly one reminder per day; a killed worker's run recovers through the sweeper on staging |

**Then frontend:** login and the admin screens → task inbox and scorecards → apply page → job and form editor → canvas (Vue Flow over `shared/workflow`) → pipeline and timeline. Run the reference's **paper-canvas test** with real recruiters before starting the canvas.

---

### Phase 0 results (2026-10-19)
| Spike | Result |
|---|---|
| Nuxt 4.6 build for `cloudflare_module` with a custom entry | ✓ |
| Queue send → awaited consumer, cron → awaited handler (`wrangler dev --test-scheduled`) | ✓ locally |
| Drizzle transaction plus rollback through Hyperdrive (local) → Neon | ✓ |
| PDF (`unpdf`) and DOCX (`fflate` + `word/document.xml`) text inside workerd; magic-byte sniff; R2 put with sha256 | ✓ (`test/extract.test.ts`) |
| Email idempotency on Cloudflare Email Service | ✗ not supported, so mocked for now; Resend later |
| Migration `0000_init` applied to Neon | ✓ |
| Deploy to Cloudflare | **Pending**: wrangler isn't logged in. Needs `wrangler login`, then create the Hyperdrive config, the queue and the R2 bucket, and put their ids in `wrangler.jsonc` |

Remove `server/api/_spike/` once the deployed check passes.

### Phase 1 status (2026-10-19)
Built: Better Auth with Google (`server/utils/auth.ts`), the invite and admin gate in `databaseHooks`, guards `requireUser`, `requireManager` and `requireAdmin` (role re-checked on every request), and routes for `/api/me`, roles, users, invites and settings. Migration `0001` seeds the `Manager` and `Employee` roles.

Verified:
- `test/access.test.ts` (pure rules).
- `test/auth.int.test.ts`: on Neon, through Better Auth's own create-user and create-session path. Covers the admin without an invite, the invite role being copied and the invite consumed, refusal of un-invited and unverified emails, and a deactivated user getting no session.

Waiting on Google credentials: a real Google round trip.

## 9. Still open
1. AI provider and model: pick by screening quality on about 20 real CVs, with zero data retention.
2. Email: mocked for now. Going live means a Resend account and a verified sending domain.
3. Whether managers may invite employees, or only the admin. The plan assumes **admin only**.
4. Migrating in-flight applications to a newer version: deferred. Manual close and reapply is the workaround.
