# Backend reference (for the frontend)

What the API does, what it takes and what it returns. The source of truth is the code. Route files are in `server/api/` and mirror the URL. Shared types are in `shared/workflow/`, which the frontend can import directly: the canvas should use `validateVersion`, `fieldsAvailableAt`, `OPS_BY_TYPE`, `REGISTRY` and `HUMAN_TASK_PRESETS` from there instead of re-implementing them.

Design background is in `backend_plan.md`.

---

## 1. Basics

### Auth and roles
- Sign-in is Google only, through Better Auth (`/api/auth/*`). Use the Better Auth client:
  - Sign in: `createAuthClient()` then `authClient.signIn.social({ provider: 'google', callbackURL: '/' })`.
  - Sign out: `authClient.signOut()`.
- The session is a cookie, so `$fetch`/`useFetch` from the same origin need nothing extra.
- Only the admin (`ADMIN_EMAIL`) and invited emails can sign in. When a sign-in is refused, Better Auth redirects with an `error` query parameter:
  - `NOT_INVITED`
  - `EMAIL_NOT_VERIFIED`
  - `NO_ACCESS` (deactivated, or no role)

  Compare case-insensitively; this hasn't been checked against a live Google sign-in yet.
- Levels come from `GET /api/me` → `level`:

| Level | Who | Can |
|---|---|---|
| `admin` | the `ADMIN_EMAIL` user (never stored, can't be edited) | everything |
| `manager` | any role with level `manager` | jobs, workflows, all applications, inbox extras, move/retry/reassign, reports |
| `employee` | any role with level `employee` | their own tasks and the applications those tasks belong to |

- Role **names** are free text (e.g. "Recruiter", "Interviewer"); only the level matters for access.
- Guards:
  - **user**: any signed-in user with access.
  - **manager**: manager or admin.
  - **admin**: admin only.
  - Failures: 401 `unauthenticated` when there's no session, 403 `no_access` when the account is deactivated or has no role, 403 `forbidden` when the level is too low.
- **404 instead of 403:** employees get 404 for applications and tasks they can't see, so ids don't leak. Treat 404 as "not found or not yours".

### Errors
Errors use h3's JSON shape:
```json
{ "statusCode": 422, "statusMessage": "...", "message": "invalid_version", "data": { "issues": [Issue] } }
```
- `message` is a stable snake_case code; switch on it.
- `data.issues` is only present on validation errors. An `Issue` is `{ node?: string, code: string, message: string }`:
  - `message` is human-readable and can be shown as is.
  - `node` is a workflow node key, so the canvas can mark that node.
- A body that fails the route's Zod schema gets 400, with h3's validation error.

### Conventions
- IDs:
  - Users: Better Auth string ids.
  - Everything else: UUIDs. A malformed UUID in the path gets 400.
- Dates come back as ISO strings.
- JSON uses camelCase keys, except workflow configs, answers and node outputs, which are snake_case (they're referenced in templates as `{{nodes.ai.overall}}`).

---

## 2. Endpoints

### Me, roles, users, invites, settings

| Method & path | Guard | Body | Returns |
|---|---|---|---|
| `GET /api/me` | user | – | `{ id, name, email, image, level }` |
| `GET /api/roles` | manager | – | `Role[]`, `{ id, name, level, createdAt }` sorted by name (managers need it for assignee pickers) |
| `POST /api/roles` | admin | `{ name, level: 'manager'\|'employee' }` | `Role`. 409 `role_name_taken` |
| `PATCH /api/roles/:id` | admin | `{ name?, level? }` | `Role`. 409 `role_name_taken`, 404 |
| `GET /api/users/assignable` | manager | – | `[{ id, name, email, image, roleName, roleLevel, isAdmin }]`: active people who can sign in (`roleLevel` is `'admin'` for the admin), for assignee, reassign and owner pickers |
| `GET /api/users` | admin | – | `{ users: [{ id, name, email, image, active, roleId, roleName, roleLevel, createdAt, isAdmin }], invites: [{ email, roleId, roleName, createdAt }] }` |
| `PATCH /api/users/:id` | admin | `{ roleId?, active? }` | user row. `active: false` ends their sessions at once. 400 `admin_is_managed_by_env`, 422 `unknown_role` |
| `POST /api/invites` | admin | `{ email, roleId }` | invite. Re-inviting changes the role. 409 `user_exists`, 400 `admin_is_managed_by_env`, 422 `unknown_role` |
| `DELETE /api/invites/:email` | admin | – | the deleted invite. 404 |
| `GET /api/settings` | admin | – | `{ companyName, replyToEmail, consentText, aiNoticeText }` (all nullable) |
| `PUT /api/settings` | admin | the same four fields, all required (`null` allowed) | settings |

Users are never deleted, only deactivated. An invite is consumed on first sign-in.

### Jobs and workflow editing (manager)

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/jobs` | – | `[{ id, title, status, openings, closesAt, ownerId, ownerName, createdAt, publishedVersion: number\|null, hasDraft, active, stopped, hired }]`, newest first. `active`: active applications; `stopped`: active ones whose latest step failed; `hired`: closed as hired |
| `POST /api/jobs` | `{ title, description?, requirements?, openings?=1, closesAt?, from?: {kind:'standard_hire'} \| {kind:'blank'} \| {kind:'job', jobId} \| {kind:'preset', presetId} }` (default `standard_hire`) | `{ job, draft }`. The new job is `draft`, with draft version 1. `job` and `preset` copy the form and flow; 404 `source_job_not_found` / `flow_preset_not_found` |
| `GET /api/jobs/:id` | – | `{ job, draft: Version\|null, published: Version\|null }` |
| `PATCH /api/jobs/:id` | any of `{ title, description, requirements, openings, closesAt, ownerId, status: 'open'\|'closed'\|'archived' }` | job |
| `PUT /api/jobs/:id/draft` | `{ form: FormField[], workflow: Graph }` | the draft `Version`. Creates draft N+1 if there's no draft |
| `POST /api/jobs/:id/validate` | – | `{ issues: Issue[] }`, empty = publishable. 409 `no_draft` |
| `POST /api/jobs/:id/publish` | – | the published `Version`. 422 `invalid_version` with `data.issues` |
| `GET /api/jobs/:id/fields?node=<key>` | – | `[{ path, type, label, options?, protected?, nodeType?, ops: Op[] }]`: the variable picker for that node |
| `GET /api/jobs/:id/applications` | – | pipeline (§2, Operations) |

- **Job status:**
  - A new job is `draft`. The first publish makes it `open`.
  - Allowed transitions: `open ↔ closed`; anything → `archived`, which is final.
  - Trying to open a job that was never published gets 409 `publish_first`.
  - Other refused transitions get 409 `cannot_go_from_X_to_Y`. Any change to an archived job gets 409 `job_archived`.
- **Requirements** (`job.*` in workflows; all optional):
  - `min_experience_years`
  - `must_have_skills: string[]`
  - `salary_min`, `salary_max`
  - `location`
  - `employment_type`
  - `workplace_type`: `on_site` | `hybrid` | `remote`
  - `salary_currency`: three letters, e.g. `EUR`
  - `show_salary`: when true, the public job page shows the salary range (otherwise it never leaves the team)

  They're frozen into the version at publish, so edits take effect from the next publish.
- **`ownerId`** must be a manager or admin (422 `owner_must_be_manager`).
- **Version:** `{ id, jobId, version, status: 'draft'|'published', form, workflow, requirements, publishedAt, createdAt }`.
- **Drafts are saved leniently.** Save often; only publish runs full validation. Editing a published job means saving a draft: the published version stays live until the next publish.
- **Running applications stay on the version they started with.** Publishing v2 doesn't move them.
- **After the first publish:**
  - Node keys and form field keys are effectively permanent: renaming one counts as removing it.
  - A field's type can't change. Publish reports this as `field_type_changed` or `node_type_changed`.
- **Validate as the user edits:** call `validateVersion(form, workflow)` from `shared/workflow/graph` client-side. Before publishing, call `/validate`, which also checks assignees, roles and compatibility with older versions.

### Step presets (manager)

Company-wide starting points for canvas steps. A step copies a preset's config when it's added, so editing or deleting a preset never changes flows that already use it. Sections follow the step type (`PRESET_SECTIONS` in `shared/workflow/presets.ts`): system (`cv_parse`, `ai_review`, `send_email`), decisions (`condition`, `set_variable`), person (`human_task`), endings (`end`). The built-ins in `BUILTIN_PRESETS` are seeded by migration 0006.

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/step-presets` | – | `Preset[]`, `{ id, type, label, description, config, position, inPalette, createdAt }`, by position |
| `POST /api/step-presets` | `{ type, label, description?, config, inPalette?=true }` | 201 `Preset`, placed last in its section. 422 `invalid_preset` with `data.issues` when the config doesn't fit the type |
| `PATCH /api/step-presets/:id` | any of `{ label, description, config, inPalette }` (the type can't change) | `Preset`. 422 `invalid_preset`, 404 `preset_not_found` |
| `DELETE /api/step-presets/:id` | – | the deleted preset. 404 `preset_not_found` |
| `PUT /api/step-presets/order` | `{ section, ids }`: every preset of that section, in the new order | the section's presets. 409 `section_changed` if the list isn't the section's current one, 422 `unknown_section` |

Only the config's shape is checked; field references (e.g. `nodes.ai.overall`) depend on the flow a preset lands in, and publish checks those.

### Flow presets (manager)

Saved form + flow pairs that a new job (`POST /api/jobs` with `from: {kind:'preset', presetId}`) or a job's draft starts from. A job copies the preset, so editing or deleting a preset never changes jobs that used it. Standard hire stays built into the code (`STANDARD_HIRE`) and isn't a row. Loading a preset into an existing job's draft is a plain `PUT /api/jobs/:id/draft` with the preset's `{ form, workflow }`.

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/flow-presets` | – | `FlowPreset[]`, `{ id, name, description, form, workflow, createdAt }`, by name |
| `POST /api/flow-presets` | `{ name, description?, form, workflow }` | 201 `FlowPreset` |
| `PATCH /api/flow-presets/:id` | `{ name?, description? }`, or `{ form, workflow, name?, description? }` (form and flow only together) | `FlowPreset`. 404 `flow_preset_not_found` |
| `DELETE /api/flow-presets/:id` | – | the deleted preset. 404 `flow_preset_not_found` |

`form` and `workflow` take the same lenient shape as a draft (`draftShape` in `server/domain/jobs.ts`), so a half-built flow can be saved; problems surface when a job using it validates or publishes. What a preset carries from the job it was saved from is found by helpers in `shared/workflow/flowPresets.ts`: `namedPeople(workflow)` (person steps assigned to named users), `withoutNamedPeople(workflow)` (those users swapped for the job owner, roles kept) and `jobFieldsRead(workflow)` (the `job.*` requirements the flow reads; an AI review counts as reading must-have skills and minimum years).

### Public apply (no auth)

| Method & path | Notes |
|---|---|
| `GET /api/public/jobs/:id` | `{ id, title, description, companyName, contactEmail, location, employmentType, workplaceType, openings, postedAt, salary: { min, max, currency } | null, minExperienceYears, mustHaveSkills, closesAt, form: [{ key, label, type, required, min?, max?, options? }], consentText, aiNoticeText }`. 404 `job_not_open` unless the job is published, open and before `closesAt` |
| `POST /api/public/jobs/:id/apply` | multipart; see below. 201 `{ ok: true }` |

How to send an application:
- **Turnstile token** goes in the **`cf-turnstile-response` header**, not in the form body. Missing or failed: 400 `turnstile_failed`.
- **Body:** `FormData` built by the browser (`fetch(url, { method: 'POST', body: formData, headers })`), so `Content-Length` is set; without it you get 411.
- **Total size:** 25 MB (413 `too_large`).
- **Always-present fields:**
  - `first_name`, `last_name`, `email` (required)
  - `phone` (optional)
- **Form answers:** one field per form `key`, as strings.
  - `number`: a decimal string.
  - `boolean`: `true`/`false`/`on`/`1`/`0`.
  - `date`: `YYYY-MM-DD`.
  - `list`: repeat the same key once per item.
- **Files:** a `File` under the field's key. PDF or DOCX only, checked by content rather than extension, 10 MB each.
- **Errors:**
  - 422 `invalid_application`, with `data.issues[].message` like `"email: Invalid email"` (field key before the colon).
  - 409 `already_applied`: one application per email per job.
  - 404 `job_not_open`.
- **Before submitting, show:**
  - `consentText`, with a checkbox. The backend doesn't record consent, so the checkbox only gates the submit button.
  - `aiNoticeText`.
- **After a 201,** show "application received". The workflow runs in the background.
- Salary appears only when the job's `show_salary` is on (frozen at publish); otherwise `salary` is `null`.
- `description` is Markdown (a small subset: headings, bold, italic, lists, links). Render it with `renderMarkdown` from `app/utils/markdown.ts`, which escapes all HTML first.
- `postedAt` is the first publish, not the latest.

### Tasks (inbox and scorecards)

| Method & path | Guard | Returns |
|---|---|---|
| `GET /api/tasks` | user | employee: `{ mine, calledOff }`. Manager/admin: `{ mine, calledOff, overdue, blocked, failed, stuck }`. Each is `TaskRow[]`; `calledOff` is your interviews cancelled in the last 7 days |
| `GET /api/tasks/:runId` | assignee or manager | `TaskDetail` |
| `POST /api/tasks/:runId/submit` | assignee | body `{ values: { <scorecard key>: value } }` → `{ completed: boolean }` |

```ts
TaskRow = {
  runId, nodeKey, nodeType, status, title, dueAt, overdue, error, retries, createdAt,
  applicationId, candidateName, jobId, jobTitle,
}
TaskDetail = TaskRow & {
  instructions: string | null,           // rendered when the task activated (protected refs are refused at publish)
  scorecard: ScorecardField[], minSubmissions: number, canSubmit: boolean,
  assignments: [{ userId, name, assignedAt, submittedAt, closedAt, values }],
}
ScorecardField = { key, label, type: 'number'|'boolean'|'text', required, min?, max? }
```

The inbox lists:
- `mine`: your open tasks, earliest due first. Rows have `overdue: true` when past due. The flow never moves on its own.
- `overdue` (managers): every waiting task past its due date.
- `blocked` (managers): a task that can't reach `minSubmissions` with the people still able to sign in. Fix it by reassigning.
- `failed` (managers): an automatic step that failed and is holding up the application. `error` has the code; offer **Retry** or **Move**.
- `stuck` (managers): normally empty, because automatic recovery runs every 5 minutes. Offer **Retry**.

Scorecards and blind panels:
- `canSubmit` is true only for an open assignee who hasn't submitted.
- **Blind panel:** until you submit, other assignees' `values` come back as `null`, although `submittedAt` still shows who has submitted. Managers always see everything.
- Submit errors:
  - 422 `invalid_scorecard` (with issues)
  - 409 `already_submitted`
  - 409 `task_closed` (the task finished, was moved, or you were removed)
  - 404 `task_not_found` (not your task)
- `completed: true` means your submission reached `minSubmissions` and the flow continued.

### Operations (manager unless noted)

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/applications/:id` | – (**user**: manager, or holder of a task on it) | `Timeline` |
| `GET /api/applications/:id/files/:field` | – (same access) | the file as a download (`<a href download>` works; the session cookie is sent) |
| `POST /api/applications/:id/move` | `{ to: { node: '<key>' } \| { close: 'hired'\|'rejected'\|'withdrawn' }, reason, notify? }` | `{ ok: true }` |
| `GET /api/applications/:id/emails` | – (**user**: same access as the application) | `[{ id, kind, key, to, replyTo, subject, body, createdAt, sentAt }]`, newest first |
| `GET /api/applications/:id/offers` | – | offers, newest first, each with `answer` and `emailed: { to, at } \| null` |
| `POST /api/applications/:id/offers` | `{ templateId, terms: { salary, start_date, location? }, expiresAt? }` | the offer (201); emails the candidate the link. `warning: 'seats_full'` when every opening is filled |
| `POST /api/offers/:id/resend` | – | `{ ok: true }`; emails the open offer's link again. 409 `offer_not_open` |
| `POST /api/offers/:id/answer` | `{ accepted, via: 'phone'\|'email'\|'in_person', note?, reason?, notify = true }` | `{ status: 'accepted'\|'declined' }`; the team records an answer, same effect as the link. 409 `offer_not_open` |
| `POST /api/offers/:id/withdraw` | – | the offer. 409 `offer_not_open` |
| `PUT /api/runs/:id/assignees` | `{ add?: userId[], remove?: userId[] }` | the run's assignments |
| `POST /api/runs/:id/retry` | – | `{ ok: true }` |
| `GET /api/jobs/:id/applications` | – | `PipelineRow[]` |
| `GET /api/reports/hires` | – | hire report |

```ts
Timeline = {
  application: { id, status: 'active'|'closed', outcome, currentNodeKey, createdAt, answers },
  candidate: { firstName, lastName, email, phone },
  job: { id, title }, version: number,
  form: [{ key, label, type }],          // to label answers
  nodes: [{ key, type, label }],         // the pinned workflow, to label runs
  runs: [{
    id, nodeKey, nodeType, attempt, status, branchTaken, error, retries, dueAt, overdue,
    actorId, createdAt, completedAt,
    input?, output?, evaluation?,        // managers only
    assignments: [{ userId, name, assignedAt, submittedAt, closedAt, values }],
  }],
  events: [{ id, type, data, createdAt, actorId, actorName }],
}
PipelineRow = { id, status, outcome, currentNodeKey, createdAt, version, runStatus, candidate: { firstName, lastName, email },
  dueAt, assignees: [{ id, name, submitted }] }   // the latest run's due date and open assignments (empty unless it's a task)
```

- **Timeline for employees:**
  - Protected answers are removed from `answers` and `form`.
  - `input`, `output` and `evaluation` are absent, because they can contain protected data.
  - Blind-panel rules apply here as well.
- **"Why was this person rejected?"** Find the condition run, i.e. `nodeType: 'condition'`, using `branchTaken` and `evaluation`:
  ```ts
  evaluation = {
    branch: string, missing: string[],
    branches: [{ key, result, trace: [{ ref, op, expected, actual, result, missing? }] }],
  }
  ```
  Render each branch's trace like "AI overall (actual 42) ≥ 70 → false". An AI review run's `output` has the per-criterion scores, `overall` and `summary`.
- **Move:**
  - Cancels whatever is active and jumps to that node; a closed application is reopened.
  - `{ close }` ends the application without going through an End node.
  - A reason is required; it goes in the event log.
  - Errors: 422 `node_not_in_version`, 409 `already_closed` (closing a closed application: reopen it first).
- **Close as rejected with `notify: true`** (also on `POST /api/jobs/:id/moves`): emails the candidate the flow's rejection email (a `send_email` step that leads straight to a rejected End), or a plain one.
- **Candidate emails:** every email to a candidate (flow `send_email` steps, the offer link, the confirmation of an answer, the booking link and "You're booked", a rejection by hand) is written to `candidate_emails` in the same transaction as what caused it, then sent after commit; `sentAt` is null until the provider took it (the sweeper retries). `kind`: `flow` (then `key` is the run id) · `offer` · `offer_accepted` · `offer_declined` · `booking_request` · `booked` · `rejection` · `documents`.
- **Offer answers** (the link or `answer`): at a Make offer step the step completes with `{ accepted, decline_reason? }` and the flow walks on; anywhere else the application closes as hired / withdrawn. Accepting cancels a booked interview still ahead (`booking_cancelled`; the interviewers see it under `calledOff` in `GET /api/tasks`).
- **Retry:**
  - Only for the application's **latest** run, when it's `failed` or stuck `running`.
  - Errors: 409 `not_latest_run`, `not_retryable`, `application_closed`.
- **Reassign:**
  - Only while the task is waiting; otherwise 409 `task_closed`.
  - Submitted scorecards are kept.
  - Errors: 422 `bad_assignee` (inactive, no role, unknown) and 422 `below_min_submissions`.
- **Hire report:** `{ jobs: [{ id, title, status, openings, applications, hired, fillRate }], totals: { jobs, openings, hires, fillRate } }`. It covers every job that has ever been published; `fillRate` is between 0 and 1.

**Run statuses:**

| Status | Meaning |
|---|---|
| `pending` | queued |
| `running` | a worker has it |
| `waiting_on_human` | a task |
| `completed` | done |
| `failed` | stopped; needs a person |
| `cancelled` | a move or close replaced it |

**Event types** (`events[].type`):

| Type | Notes |
|---|---|
| `application_submitted` | |
| `task_assigned` | |
| `task_submitted` | |
| `task_reassigned` | |
| `manual_move` | `data: { reason, to, previous }` |
| `closed` | `data: { outcome, node? \| manual }` |
| `reopened` | |
| `run_failed` | `data: { node, error }` |
| `run_retried` | |
| `offer_made`, `offer_withdrawn` | `data: { offerId }` |
| `offer_answered` | `data: { offerId, accepted, via: 'link'\|'phone'\|'email'\|'in_person', reason?, note? }`; actor: who recorded it, or who made the offer (link) |
| `booked` | `data: { runId, startsAt, previous }` |
| `booking_cancelled` | `data: { runId, startsAt }` |

---

## 3. Workflow model (for the editor and canvas)

```ts
Graph = { nodes: GraphNode[], edges: GraphEdge[] }
GraphNode = { key, type, config, label?, position?: { x, y } }
GraphEdge = { from, to, branch? }            // branch only on edges leaving a condition
```
- Keys (nodes, form fields, scorecard fields, branches, variables): `^[a-z][a-z0-9_]{0,39}$`.
- Rules publish checks, so the canvas should enforce them too:
  - Exactly one trigger; the trigger has no incoming edges.
  - Every node has one outgoing edge, except End (none) and Condition (one per branch, plus `default`, plus `missing` when `on_missing`).
  - No loops; every node reachable from the trigger.

### Node types

| type | kind | config | outputs (`nodes.<key>.*`) |
|---|---|---|---|
| `application_received` | trigger | `{}` | – |
| `cv_parse` | auto | `{ file_field }` (a form `file` field) | `text`, `skills` (list), `years_experience`, `current_title`, `file_sha256` |
| `ai_review` | auto | `{ criteria: [{ key, label, description }] (1–10), instructions?, cv_text_ref? }` | one number (0–100) per criterion key, plus `overall` and `summary` |
| `set_variable` | instant | `{ fields: [{ key, type, label?, source: { kind:'literal', value } \| { kind:'ref', ref } }] }` | the field keys |
| `condition` | instant | `{ branches: [{ key, label, rule }], on_missing }` | – (it routes by `branchTaken`) |
| `human_task` | human | `{ title, instructions?, assignees: { users[], roles[], job_owner }, scorecard: ScorecardField[], min_submissions=1, due_days?, booking?: { duration_min, where? }, offer? }` | scorecard keys (numbers averaged, text joined; booleans give `<key>` (everyone said yes) and `<key>_any`), plus `submitted_count`. With `offer: true`: `accepted` (boolean), `decline_reason` |
| `send_email` | auto | `{ subject, body }` (templates; sent to the candidate, Reply-To from settings) | `sent` |
| `end` | terminal | `{ outcome: 'hired'\|'rejected'\|'withdrawn' }` | – |

Node type notes:
- **Human tasks:**
  - Presets for the palette are in `HUMAN_TASK_PRESETS`: interview, assessment review, HR approval.
  - Their titles and instructions can't reference protected fields (`protected_ref`).
  - **Make offer** is a human task with `offer: true` and an empty scorecard (`MAKE_OFFER` in the registry). It takes no scorecard (`submit` gives 409 `answer_with_offer`): making the offer emails the letter, and the offer's answer (the candidate's link, or `POST /api/offers/:id/answer`) completes it with `{ accepted, decline_reason? }`. A condition after it routes accepted → hired, otherwise → withdrawn.
  - **Booking:** with `booking`, the candidate is emailed a link to pick a slot; `where` (optional) shows on the booking page, in the emails and as the .ics LOCATION.
- **`cv_text_ref`** may only be a non-protected `form.*` text field or `nodes.<cv_parse>.text`, otherwise `ai_input_not_allowed`.
- **Kill switch:** a node type listed in the env var `DISABLED_NODE_TYPES` fails its runs with `disabled`; they show up under `failed`.

### References, rules and templates
- **Readable paths:**
  - `candidate.first_name|last_name|email|phone`
  - `form.<key>`
  - `job.title|openings|<requirement>`
  - `nodes.<key>.<output>`, but only from nodes that always run before this one
- **Variable picker:** use `GET /api/jobs/:id/fields?node=<key>` (or `fieldsAvailableAt` locally) instead of building the list yourself.
- **Rule:** `{ all: Rule[] } | { any: Rule[] } | { not: Rule } | { ref, op, value? , valueRef? }`. Operators by type (`OPS_BY_TYPE`):

| type | ops |
|---|---|
| number | eq neq gt gte lt lte between in nin exists |
| date | eq neq gt gte lt lte between exists |
| string | eq neq in nin contains exists |
| text | contains exists |
| enum | eq neq in nin exists |
| boolean | is_true is_false exists |
| list | contains exists |
| file | exists |

- `value` shapes:
  - `between` takes `[min, max]`.
  - `in`/`nin` take an array.
  - `exists`/`is_true`/`is_false` take no value.
  - `valueRef` compares against another field instead of a literal.
- **Missing data:** a comparison on a missing value is false. With `on_missing: true`, a branch with missing data stops evaluation at the `missing` branch, which in Standard hire goes to manual review.
- **Templates** (`human_task.title`/`instructions`, `send_email.subject`/`body`):
  - Use `{{path}}`.
  - An unknown path fails publish (`unknown_ref`).
  - An email whose ref is empty at send time fails with `missing_ref`, so a "Dear ," email is never sent.

### Form fields
```ts
FormField = { key, label, type: 'string'|'text'|'number'|'boolean'|'enum'|'date'|'file'|'list', required, min?, max?, options?, protected? }
```
- `min`/`max` limit the value for numbers and the length for string, text and list.
- `options` are required for `enum`.
- `protected` (e.g. date of birth, gender): stored, but never sent to the AI or shown to employees.
- The core fields (`first_name`, `last_name`, `email`, `phone`) are always present and aren't part of `form`.

### Standard hire template
CV parse → AI review → condition `screen`:
- shortlist → interview
- reject → rejection email → End(rejected)
- missing or default → manual review → `review_decision`: advance → interview, otherwise → rejection email

The interview leads to the `decision` condition:
- hire → `make_offer` (Make offer, job owner) → `offer_answer`: accepted → End(hired), otherwise → End(withdrawn)
- otherwise → rejection email → End(rejected)

Versions published before Make offer (hire → offer email → End(hired)) keep running as they were; an offer answered there closes the application directly.

The full graph is in `shared/workflow/templates.ts` (`STANDARD_HIRE`).

---

## 4. Issue codes the editor will see
Show `message` as is; use `code` for styling or grouping.

| Area | Codes |
|---|---|
| Form | `invalid_form`, `duplicate_field`, `enum_without_options`, `min_gt_max` |
| Graph | `bad_key`, `duplicate_node`, `unknown_type`, `invalid_config`, `trigger_count`, `trigger_incoming`, `dangling_edge`, `self_loop`, `end_outgoing`, `out_edges`, `branch_edges`, `unknown_branch`, `unexpected_branch`, `cycle`, `unreachable` |
| Refs and rules | `unknown_ref`, `type_mismatch`, `bad_operator`, `bad_value`, `bad_tag`, `duplicate_key`, `ai_input_not_allowed`, `protected_ref` |
| Publish only | `bad_assignee`, `bad_role`, `not_enough_assignees`, `field_type_changed`, `node_type_changed` |

---

## 5. Run errors (shown on failed runs and in the inbox)

| `error` starts with | Meaning | What a manager does |
|---|---|---|
| `no_assignees` | nobody to assign at activation | fix roles or users, then retry |
| `missing_file`, `file_not_found`, `checksum_mismatch` | the CV is missing or altered | move on manually |
| `unreadable_cv` | scanned or corrupt CV | move to manual review |
| `ai_not_configured`, `ai_error` | AI not set up, or a permanent provider error | fix config, retry |
| `missing_ref` | email template ref was empty | move, or retry after fixing data |
| `email_failed` | email provider refused | retry |
| `disabled` | the kill switch is on for this type | re-enable, retry |
| `invalid_config`, `no_handler` | the node config no longer parses, or the type has no handler | contact a developer |
| `error: …`, `worker_lost` | temporary errors that ran out of their 3 automatic retries | retry |

---

## 6. Local development
- **Dev server:** `pnpm build && npx wrangler dev --port 8799` (Workers runtime, queue and cron). `pnpm dev` (Nuxt) works for UI work, but there's no queue there.
- **`.env`:**
  - `ADMIN_EMAIL`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (redirect URI `http://localhost:8799/api/auth/callback/google`)
  - `AI_MOCK=1` (deterministic fake AI)
  - Email is mocked; it logs `[email:mock]`.
- **Turnstile:** the site key for dev is `1x00000000000000000000AA` (always passes; it pairs with the test secret in `.env`).
- **Demo job:** `pnpm db:seed` creates a published demo job in the dev database.
- **Cron triggers in dev:**
  - `curl "localhost:8799/__scheduled?cron=*/5+*+*+*+*"` (sweeper)
  - `curl "localhost:8799/__scheduled?cron=0+8+*+*+*"` (reminders)
