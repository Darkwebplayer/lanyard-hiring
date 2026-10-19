# Recruitment Platform: Final MVP Reference

Status: build reference for release one · 2026-10-19
Sources: `Recruitment Platform MVP Specification.pdf` (the spec) and `project.md` (discovery decisions).
Scope: get the core workflow running end to end on a basic, deployable app. Anything that does not serve that scope is deferred and listed in section 12.

---

## 0. How project.md relates to the spec

`project.md` is a log of discovery-interview decisions. It copies the spec's node registry word for word, so the two describe the same product. Most of its answers confirm what the spec already says. A few change it, and a few would add complexity without adding value. Each one was reviewed:

| project.md decision | Verdict | Effect on this document |
|---|---|---|
| One persona: the in-house recruiter builds the flow and works it. No agency or hiring-manager seats | **Adopted** | Roles collapse to `admin` and `recruiter` (section 2) |
| Public hosted form link per job | **Adopted, simplified** | `/apply/:jobId`. Per-tenant subdomains are deferred (section 3) |
| Form submit returns at once; the workflow runs in the background | Already in spec | No change |
| CV parse or AI fails: retry, then flag a human | Already in spec | 3 retries, then `failed` shows in the inbox |
| Email from the app domain, Reply-To set to the recruiter's mailbox | **Adopted** | Section 8. Needs one verified sending domain |
| Overdue human task: marker plus reminder email, flow does not move | **Adopted** (spec had deferred reminders) | Marker is computed when read. Reminders come from one daily Cron Trigger that sits outside the engine |
| Candidate events (reply, withdrawal) enter only through the recruiter | Already in spec | Manual move |
| Pin in-flight candidates to the version they started on | Already in spec | No change |
| Version the whole flow *and* each node separately | **Rejected** | `(workflow_version_id, node_key)` already identifies a frozen node config. A separate node-version table would duplicate it |
| Graph belongs to one job; "duplicate to job" marks broken refs | Already in spec | Template cloning plus publish validation does this already |
| The step log is the record; the recruiter replays a stuck step | Already in spec | `node_runs` is the record. Retry also works on stale `running` runs (section 7) |
| Form fields are additive only (never renamed or removed) | **Rejected** | Form and workflow publish together, and publish validation already blocks dangling refs. Field *keys* stay immutable; labels can change |
| Rewiring breaks a reference: allow the edit, block publish | Already in spec | Drafts may be invalid; publish enforces validity |
| AI auto-reject is allowed, with a compliance kit | **Adopted** | Section 9. The kit is mostly config and process, not new features |
| Store scores plus a pointer, no copy of the input; write-once CV storage plus checksum | **Adopted, simplified** | Immutable R2 keys plus `sha256`. The AI run stores a hash of the exact input instead of the prompt text |
| CV is owned by the app's file store; AI and email only see it in transit | **Adopted** | Use a provider with no data retention (section 9) |
| Appeal reaches the recruiter mailbox; recruiter opens an appeal task on the run | **Adopted, simplified** | Reopen through manual move with reason `appeal`. No new feature |
| Email provider down: queue, retry, then flag | Already in spec | The same retry path as any automatic node |
| Per-node-type kill switch; AI off means a human task instead | **Changed** | A kill switch fails the run as `disabled`. Turning it into a human task would change its output schema and break downstream refs (section 7) |
| Success metric: hires against open positions and job postings | **Adopted** (missing from spec) | `jobs.openings` column plus one report (section 10) |
| All eight node types at launch | Already in spec | No change |
| Out of scope: job boards, calendar sync, agency seats | Already in spec | No change |
| Riskiest belief: recruiters can build graphs without engineers. Test with a paper canvas and five recruiters | **Adopted** | Runs during phases 1–4, before the canvas is built (section 11) |

**Bottom line:** project.md is relevant. Its real contributions are the single persona, reminders, the hire metric, the email sender model and the compliance stance. It also exposes three places where the spec over-builds for this scope: subdomains, the role split and the separate upload endpoint. Its proposals for node-level versioning, additive-only forms and the AI-to-human fallback are rejected because they add complexity the spec's design already makes unnecessary.

---

## 1. Product summary

A company (tenant) signs up, invites its recruiters and creates jobs. Creating a job has two steps:

1. **Job and form:** job details, number of openings, closing date, structured requirements, and the application form.
2. **Workflow:** a node-based canvas that defines the hiring process, from application received to hired, rejected or withdrawn.

Candidates apply through a public link for each job. Recruiters work from a task inbox that lists their assigned human tasks, overdue items and failed steps.

### MVP goals
- A tenant runs a complete hiring cycle for one job: apply, CV parse, AI screening, interview, decision, offer email, then hired or rejected.
- Every decision can be explained in the UI ("why was this person rejected?").
- Tenant data is isolated.
- Workflows are built from eight configurable node types, never from custom code.
- Release one is judged by **hires against openings** across published jobs.

### Persona
The in-house recruiter at a growing company. Today they screen CVs by hand in spreadsheets and email. They build the flow and work it. They settle scope disagreements, so they should be the release-one decider.

---

## 2. Users and roles

| Role | Can do |
|---|---|
| `admin` | Everything a recruiter can do, plus company settings and user management (invite, deactivate, change role) |
| `recruiter` | Create and publish jobs (form and workflow), see all candidates, do human tasks, move candidates manually, retry failed runs |
| Candidate | Applies through the public form. No account |

Rules:
- Job titles are free text and carry no permissions.
- A panel task is assigned to several recruiters. An assignee cannot see the other scorecards until they submit their own, which avoids anchoring bias.
- Every state-changing action is written to `application_events`.

> Δ vs spec: the manager/staff split is dropped, because project.md has a single persona. `role` stays an enum, so adding `manager`/`staff` in stage 2 is a single enum migration.

---

## 3. Architecture

| Concern | Choice |
|---|---|
| App and API | Nuxt 4 on Cloudflare Workers (Nitro `cloudflare_module` preset) |
| Tenant resolution | **Staff:** from the session. **Public:** from the job (`/apply/:jobId` → `jobs.tenant_id`). Never from the request body |
| Database | One shared Postgres (Neon) through Hyperdrive, using Drizzle ORM |
| Auth | **Better Auth** (Drizzle adapter, email and password, invite links). Decided now; the spec had left it open |
| Files | R2, key `tenantId/jobId/applicationId/<uuid>`, written once and never overwritten |
| Async work | Cloudflare Queues (CV parse, AI review, email), plus a dead-letter queue |
| Scheduled | One Cron Trigger, daily: overdue reminders. It is not part of the engine |
| AI | One `callLLM(schema, input)` function. Start with an external LLM API that supports JSON-schema output and does not retain data |
| Email | Resend (supports idempotency keys). Sender `no-reply@<app-domain>`, `Reply-To` set to the tenant's recruiter mailbox |
| Bot protection | Turnstile on the apply form |
| Canvas | Vue Flow |

> Δ vs spec, deferred: wildcard subdomains, KV host cache and reserved slugs. Keep `tenants.slug` so subdomains can be added in stage 2 next to custom domains. Postgres RLS remains a **gate before onboarding real customers**, not a phase-1 task. In the meantime, every query goes through the tenant-scoped query helper, and isolation tests prove that it works.

### Layout
- `shared/workflow/`: pure TypeScript used by both the canvas and the server. Field types, rule evaluator, node registry, graph validation, template resolver.
- `server/engine/`: plain functions that do not depend on Nuxt, so they can later move into a Durable Object or a Cloudflare Workflow.
- `server/domain/`: job drafts, publishing, application submission.
- `server/db/schema.ts`: Drizzle schema.
- `server/api/`: thin routes. Each one validates input, resolves tenant and user, and calls the domain layer.

> Risk to verify in week 1: wiring the queue consumer into Nitro. If it is awkward, run the consumer as a second small Worker that imports `server/engine/`. That code is already independent of Nuxt.

---

## 4. Data model

| Table | Purpose |
|---|---|
| `tenants` | name, slug (reserved for later), settings (`reply_to_email`, AI notice text) |
| `users` | email unique per tenant, role (`admin` or `recruiter`), free-text job title, active flag |
| `jobs` | title, description, structured requirements, **`openings` (int)**, status, closing date, owner, pointers to the published form and workflow versions |
| `form_versions` | versioned JSON list of form fields; draft or published |
| `workflow_versions` | versioned JSON graph (nodes and edges); draft or published |
| `candidates` | one per person per tenant (email unique per tenant) |
| `applications` | candidate × job, pinned `form_version_id` and `workflow_version_id`, answers (JSONB), status, **`outcome`** (`hired` / `rejected` / `withdrawn`, set by the End node), cached `current_node_key` |
| `node_runs` | one row per node execution. Holds both history and live state |
| `task_assignments` | which users a human-task run is assigned to |
| `task_submissions` | each assignee's scorecard values (unique per run and user) |
| `application_events` | append-only audit log |

Key rules:
- `tenant_id` is on every table and is the first column of every composite index.
- **State lives in `node_runs`.** A candidate's position is the set of runs that are `pending`, `running` or `waiting_on_human`. `current_node_key` is only a display cache.
- History is keyed by run: `(application_id, node_key, attempt)` is unique.
- Versions are frozen when published. Form and workflow publish together. Editing a published job creates draft N+1, and applications in flight stay on their own version.
- A node's version *is* `(workflow_version_id, node_key)`. There is no separate node-version table.
- Core candidate fields (name, email, phone) are columns. Everything else is JSONB answers, validated against the pinned form version.
- `node_runs` fields: status, input, output, `branch_taken`, `evaluation` (rule snapshot), retries, error, actor, `due_at`, timestamps.
- File answers store `{ key, sha256, size, mime }`.

---

## 5. Application form

- Stored as versioned JSON. Each field has a key, label, type, required flag, and optional min/max/options.
- Types: string, text, number, boolean, enum, date, file, list.
- Core fields (first name, last name, email, phone) are always present and cannot be configured.
- A field **key cannot change once published.** Labels can be renamed freely. A field removed in version N+1 can only be published if the workflow no longer references it, which publish validation enforces.
- **Protected** fields (for example date of birth or gender) are stored but never sent to the AI. Date of birth is off by default.
- **Notices:** the form shows the tenant's consent text and AI-screening notice (static text from tenant settings). This is part of the compliance kit.
- **Files:** PDF and DOCX only, 10 MB maximum, checked by magic bytes as well as extension. Uploaded **in the same multipart submit request**. The server streams each file to R2 under a fresh key and stores its sha256.
- Validation: the server checks answers against a Zod schema generated from the pinned form. Empty values count as absent.
- The closing date is enforced at request time. One application per candidate per job.

> Δ vs spec: the separate `POST /api/public/uploads` is removed. An anonymous pre-upload endpoint invites abuse, leaves orphaned files, and needs the key-prefix check. Uploading inside the submit request avoids all three, and 10 MB fits comfortably within Worker request limits.

---

## 6. Workflow model

### Graph
JSON with `nodes` (key, type, config, position) and `edges` (from, to, optional `branch`). Node keys are stable snake_case and labels can be renamed. **A graph belongs to one job.** "Duplicate to another job" and "start from template" both copy the JSON. Publish validation then marks any ref that does not resolve.

### Node types (all eight ship in release one)

| Node | Kind | Config | Output |
|---|---|---|---|
| Application received | Trigger | none | `candidate.*`, `form.*` |
| CV parse | Automatic | source file field | `text`, `skills`, `years_experience`, `current_title`, `file_sha256` |
| AI review | Automatic | criteria list, optional instructions, optional CV text ref | one 0–100 score per criterion, `overall`, `summary` |
| Set variable | Logic | named fields, each with a type and a source (literal or copy of a field) | the defined fields |
| Condition | Logic | ordered branches, mandatory default, optional missing-data branch | branch |
| Human task | Human | title, assignee rule, scorecard, completion rule, due days | derived from the scorecard |
| Send email | Automatic | subject and body templates | `sent` |
| End | Terminal | outcome: hired, rejected or withdrawn | none |

Outputs come from each node's config. Each output is stored under the node's key and read by name (`nodes.<key>.<field>`). Nothing is wired from one node to the next.

### Human task
- Assignees: specific recruiters, or the job owner. Resolved when the task activates. If no one can be resolved, the run is `failed` with `no_assignees`.
- Scorecard fields: number (min/max), boolean, text.
- Completion: `min_submissions` (1, or N for a panel).
- Aggregation: numbers are averaged, booleans produce `field` (all agreed) and `field_any` (at least one), and text is joined.
- `due_at = activated_at + due_days`. **Overdue** means `due_at < now()` while the run is still waiting, and is computed when read. The flow does not move.
- Presets in the palette: Interview, Technical assessment review, HR approval. Each is a config entry, not a new type.

### Registry
One entry per type: a Zod config schema, an `outputSchema(config)` function and a runtime handler. The same definition drives the config panel, save validation and runtime checks.

### Template
"Standard hire": CV parse → AI review → condition (shortlist / reject / missing → manual review) → interview (2-person panel) → decision condition → offer email + End hired, or rejection email + End rejected. Tenants clone it.

---

## 7. Data flow, rules and execution

### Context (assembled on demand, never stored)
`candidate.*`, `form.*`, `job.*` (title, min_experience_years, must_have_skills, salary_min, salary_max, location, employment_type, openings), and `nodes.<key>.*` (latest attempt wins).

### Variable picker and conditions
These follow the spec unchanged:
- Upstream fields only, with operators filtered by field type.
- Declarative JSON rules (`all`/`any`/`not`, operators `eq neq gt gte lt lte between in nin contains exists is_true is_false`, `value` or `valueRef`).
- First match wins, and a default is mandatory.
- A comparison on a missing value is false. `on_missing_branch` routes to manual review.
- Each condition run stores `branch_taken` and the full evaluation snapshot. **This snapshot is the rejection explanation.**
- Templates use `{{candidate.first_name}}`, `{{job.title}}`, `{{nodes.ai.summary}}` and share the same resolver and validator.

### Publish validation
A workflow can be published only if:
- there is exactly one trigger and it has no incoming edges
- every config matches its schema
- each non-terminal, non-condition node has exactly one outgoing edge
- each condition branch, including the default, has exactly one outgoing edge
- the graph has no cycles
- every node is reachable and every path ends in an End node
- every `ref`/`valueRef` resolves upstream with an operator that fits its type

If a ref does not resolve, the node shows as **broken** on the canvas.

### Engine (event-driven, no polling)
1. The submit creates the candidate and application, pinned to the published versions, and calls `startApplication`. It responds as soon as that commits.
2. Walk forward:
   - Instant nodes (trigger, set variable, condition, end) complete inside the same transaction.
   - Automatic nodes get a `pending` run plus a queue message.
   - Human tasks get a `waiting_on_human` run, assignments, `due_at` and a `task_assigned` event.
3. The queue consumer runs `executeAutoRun(runId)`: claim the run, run the handler, complete it, activate the successors.
4. `submitTask` stores a scorecard. Once `min_submissions` is reached, the run completes and the engine continues.

### Safety properties (kept from the spec, all required)
- **Atomic completion:** a run completes and its successors activate in one transaction. Queue messages are sent only after commit.
- **Idempotent claim:** a conditional update on status. A duplicate message or double submit is a no-op.
- **Retries:** an automatic node retries 3 times through queue redelivery, then becomes `failed` and an event is logged. This covers CV parse, AI outages and email-provider outages alike.
- **Email idempotency:** the run id is the provider idempotency key.
- **Inactive applications:** in-flight automatic runs are cancelled instead of completed.
- **Stale runs:** a run stuck in `running` for more than 15 minutes (worker died after claiming it) shows as stuck in the inbox and can be retried like a failed run. There is no sweeper in the MVP.

### Manual overrides
A recruiter can move a candidate to any step, including End (reject at any time), or reopen a closed one. Active runs are cancelled. A `manual_move` event records the actor, reason and previous state. A recruiter can also retry failed or stuck runs.

### Kill switch
Env var `DISABLED_NODE_TYPES` (for example `ai_review`). A handler for a disabled type fails the run with error `disabled`, and the run surfaces in the inbox. Once the type is re-enabled, the recruiter retries, or moves the candidate manually. Other candidates' flows keep running.

> Δ vs project.md: no automatic substitution of a human task. Its output schema would differ from AI review's, so every downstream `nodes.ai.*` ref would resolve to missing.

---

## 8. Email

- Provider: Resend, with idempotency keys.
- From `no-reply@<app-domain>`, which needs one verified sending domain (SPF/DKIM/DMARC). `Reply-To` is the tenant's `reply_to_email`, so candidate replies and appeals arrive in the recruiter mailbox.
- Send email node: rendered from templates and sent from the queue, with retries as in section 7.
- **Reminders:** a daily Cron Trigger finds overdue `waiting_on_human` runs and sends one reminder per assignee per day. The key is `runId:date`, so reruns never send twice. Reminders never move the flow.

---

## 9. AI review and compliance

Release one stance (from project.md): **auto-reject on AI score is allowed, and the flow author decides.** It ships with a compliance kit:

| Kit item | How it is delivered |
|---|---|
| Notice on the form | Tenant AI-notice text shown on every apply form (section 5) |
| Stored criteria and scores | The AI run stores criteria (in the pinned workflow version), scores, model name, prompt version and `input_sha256` of the exact payload sent |
| Evidence behind a score | The CV is an immutable R2 object with its sha256 recorded. The CV parse output (text) is in `node_runs`. Hashes link score → input → file |
| Appeal route | The candidate replies to any email, which reaches the recruiter mailbox. The recruiter reopens the application with manual move, reason `appeal`, into a review task. The `manual_move` event is the record |
| Yearly bias audit | A process, not a feature. The data lives in `node_runs`. An export is deferred |

Defaults:
- **Structured output:** the JSON schema is generated from the criteria and validated on return. Malformed output counts as a failure and is retried.
- **Input minimisation:** protected fields, file fields, name and email are never sent. The prompt tells the model to ignore protected attributes.
- **Template nudge:** the standard template routes `on_missing_branch` and the borderline score band to a manual review task.
- **Data ownership:** the app's R2 owns the CV. The AI and email providers see data only in transit and must be configured for zero retention.
- Retention and deletion jobs are deferred. Write down the retention policy now.

---

## 10. API surface

**Public** (tenant from the job)

| Route | Purpose |
|---|---|
| `GET /api/public/jobs/:id` | Job details and form fields (published and open only) |
| `POST /api/public/jobs/:id/apply` | Multipart submit: answers, files and Turnstile token |

**Staff** (tenant from the session)

| Route | Purpose |
|---|---|
| `POST /api/jobs` · `GET /api/jobs` | Create or list jobs |
| `PUT /api/jobs/:id/form` | Save form draft |
| `PUT /api/jobs/:id/workflow` | Save workflow draft |
| `GET /api/jobs/:id/workflow/fields?node=` | Variable picker |
| `POST /api/jobs/:id/publish` | Validate and freeze |
| `GET /api/tasks` | My tasks, including overdue, failed and stuck runs |
| `POST /api/tasks/:runId/submit` | Submit a scorecard |
| `GET /api/jobs/:id/applications` | Pipeline list (by current node) |
| `GET /api/applications/:id` | Timeline: runs, outputs, decision snapshots, events |
| `POST /api/applications/:id/move` | Manual move with reason |
| `POST /api/runs/:id/retry` | Retry a failed or stuck run |
| `GET /api/reports/hires` | Hire metric |
| Better Auth routes + `/api/users` | Sign-up, login, invite, deactivate |

**Hire metric**, one query: for each job, `openings` and `hired = count(outcome='hired')`, with fill rate = hired / openings. Tenant totals: jobs published, openings, hires.

---

## 11. Build plan

The order proves the engine before the canvas exists. The paper-canvas test runs in parallel with phases 1–4.

| Phase | Deliverable | Done when |
|---|---|---|
| 1. Foundations | Nuxt on Workers deploy, Drizzle schema and migrations, Better Auth, tenant sign-up, invite recruiters, tenant-scoped query helper | An admin signs up, invites a recruiter, and the isolation test shows tenant B's ids return 404 |
| 2. Jobs and forms | Job CRUD (with openings), form builder, drafts and versions | A job has a saved form draft |
| 3. Engine core | Registry, rule evaluator, context resolver, graph validation, publish, `node_runs` engine, queue consumer, CV parse / AI / email handlers | A published job built from the template JSON runs an application from trigger to End in an integration test |
| 4. Apply page | `/apply/:jobId`, form renderer, multipart upload to R2, Turnstile | A real candidate applies and the flow starts |
| 5. Task inbox | Assignment, my-tasks, scorecards, panels, blind scorecards, overdue markers, failed and stuck runs with retry, daily reminder cron | Two recruiters submit and the flow continues; an overdue task gets one reminder |
| 6. Canvas | Vue Flow over the graph JSON, palette with presets, config panels, variable picker, broken-node markers, template clone, duplicate to job | A recruiter builds and publishes a workflow without touching JSON |
| 7. Operations | Pipeline list, candidate timeline with decision explanation, manual move and reopen, hire report | A recruiter can answer "why was this person rejected?" and see hires against openings |

**Paper-canvas test** (the riskiest belief): before phase 6 starts, five recruiters each sketch their real hiring flow with paper cards of the eight node types. If they cannot express their flow, or they need parallel steps, fix the registry or the stage-2 order *before* building the canvas.

### Testing priorities
- **Unit:** rule evaluator (including missing data), graph validation, scorecard aggregation, form schema generation, template resolver.
- **Integration (real Postgres):** happy path, rejection path, duplicate queue delivery, double submit, closing date, duplicate application, protected fields excluded from AI input, manual move and reopen, kill switch.
- **Isolation:** every staff route called with another tenant's ids returns 404.

---

## 12. Deferred (stage 2) and how the MVP prepares for each

| Feature | Preparation already in the MVP |
|---|---|
| Per-tenant subdomains, custom domains | `tenants.slug` exists. Add a wildcard route, KV host cache and Cloudflare for SaaS |
| Postgres RLS | Every query is already tenant-scoped. Add a transaction-per-request `app.tenant_id` and policies **before real customers** |
| Manager/staff roles, hiring-manager and agency seats | `role` is an enum. Task assignment is already per user |
| Parallel branches and joins | Add `fork_run_id`, `branch_key` and a `join_state` table. Relax the one-outgoing-edge rule |
| Loops (re-interview) | `attempt` already exists. Allow cycles with a max-attempt guard |
| Wait/delay nodes, stuck-run sweeper | The Cron Trigger already exists. Add sweeps over `due_at` and stale `running` runs |
| Webhooks, candidate actions, calendar, candidate status page | New registry entries plus a `waiting_external` status |
| Set-variable formulas | New source kinds in the registry |
| Retention/deletion job, bias-audit export | The data is already in `node_runs` and R2 with hashes |
| Malware scanning | Add a queue step before a file is marked safe. The MVP checks only type and size |
| Job-board posting, bulk import, billing | Not started |
| Durable execution | Move `server/engine/` into Durable Objects or Workflows. The data model does not change |

---

## 13. Decisions and open items

**Decided here:** Better Auth; Resend; tenant from session or job instead of subdomain; two roles; files uploaded with the submit; kill switch fails the run instead of substituting a task; no node-level versioning; keys immutable, but fields are not additive-only; reminders from a daily cron.

**Still open (owner: the release-one recruiter, who decides):**
1. **Regulatory scope:** which jurisdictions the first tenants hire in. This decides whether the template's auto-reject should be on by default.
2. **AI provider and model:** choose by screening quality on 20 real CVs, and confirm zero data retention terms.
3. **CV parsing:** text PDFs and DOCX only. Scanned PDFs fail clearly and go to a human. Confirm this is acceptable.
4. **RLS through Hyperdrive:** run the performance spike before onboarding real customers.
5. **Nitro queue consumer wiring:** confirm it in week 1, with a separate Worker as the fallback.
