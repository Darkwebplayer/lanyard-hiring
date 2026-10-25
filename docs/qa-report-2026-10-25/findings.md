# QA findings log

> 2026-10-25, after this run: the New job wizard, admin setup wizard, Help panel and first-run tour were added. Lines they change carry `{addressed by: ...}` or `{partly addressed by: ...}`. All other findings are unchanged, and no QA fixes are made yet.
## Setup
- Login Google only; minted sessions via scripts/qa-session.mts work. Browser had user's real httpOnly session -> needed sign-out first.
- NOTE perf: every hard navigation shows "Checking you in..." splash for ~3-4s (remote Neon from local wrangler). [A-00]
## B Team
- Team page clean: admin locked row, role dropdown, active toggle, roles w/ level descriptions. [B-01]
- PASS add role Interviewer; invite ahmad (shows as "Invited, not signed in yet" row + Cancel invite); re-invite by changing role dropdown -> Interviewer. [B-02]
- PASS switch off Marcus: confirm dialog w/ clear consequences [B-03]; his session 401 immediately; switch back on works.
- PASS role gating API: manager GET /users 403, PUT /settings 403, POST /invites 403, GET /settings 200; anon /api/jobs 401.
- UX (med): switched-off user row re-sorts to bottom immediately -> rows jump; my next toggle click hit Priya instead of Marcus (confirm dialog saved it). Keep row order stable.
- UX (low): success line still says "Invited ... as Employee" after role changed to Interviewer.
- UX (low): every Team mutation takes 3-5s with controls disabled (remote DB latency) - perceived slowness.
- minor: 403 JSON statusMessage "Server Error" for forbidden.
## B Settings
- Pre-existing consent + AI notice text was junk (job-description boilerplate) -> replaced with PDPA consent + AI notice. Live apply-form preview updates instantly (nice). [B-04]
- PASS duplicate reject reason (case-insensitive "other") blocked inline w/ clear msg. Save persisted (DB verified).
- UX (low): on Settings page, inputs render empty/greyed for ~5s while loading with no skeleton -> looks like blank settings.
- UX (med, pattern): layout shift after inline error clears made my reorder click hit a different row (moved "Other" instead). Same class as Team re-sort issue.
## A Access
- PASS manager -> /team redirects to /inbox. Empty inbox state is friendly ("No tasks yet" + link to jobs). [A-01]
- ENV: API latency 3.6-6s per call locally (/api/tasks 6.0s) -> remote Neon from laptop; every page shows skeletons 4-7s. Not representative of prod; but worth checking query count per request (auth does session+access lookups each call).
## C Library
- Steps tab well structured (System/Decisions/Person/Endings, in-palette toggles, "changing preset never changes flows" note). [C-01]
- PASS created person preset "Warehouse panel interview" (Priya+Marcus, 2 scorecards, due 5d, booking 45m). Booking toggle explains interviewers must set hours (good). [C-02]
- BUG (med): preset editor shows raw zod error at top "Scorecard.1.label: Too small: expected string to have >=1 characters" when a new question is blank; Add preset silently disabled. Should be inline "Question 2 needs a label".
- UX (med): "Add a question" clones previous question's type/range but leaves label blank + key "question" -> confusing. Scorecard "Key" field exposed to managers (jargon; auto-derived from label anyway) - hide under advanced.
- UX (low): no "Rating 1-5" answer type; must pick Number and fill Lowest/Highest manually. A rating preset is the common case for interview scorecards.
- PASS offer letter editor: variable chips insert at cursor, Preview renders. [C-03]
- UX (low): preview uses UK bakery sample data (Maya, Northwind Bakery, Leeds, GBP 28,000/yr) instead of actual company name + SGD -> odd for SG company.
- UX (low): saves are slow (5s+) with only a spinner; "Unsaved" label next to button is nice.
## D Job 1 Warehouse Ops Supervisor (AI screening template)
- New job dialog: 4 clear templates with stage chips; "Other ways to start" = Blank / Copy another job (flow-preset option hidden when none exist). No "Describe with AI" entry here - AI builder only discoverable inside canvas toolbar ("Draft from a description"). [D-01] {addressed by: wizard. "Describe it in your own words" (AI) now sits beside the templates in step 2 of New job}
- Stage list view is readable for SMB: When someone arrives / Who works here / Moves on when / Ask when moved by hand; "Your board" preview of columns. [D-02]
- COHERENCE (high): AI-screening template ends interview -> decision -> send "Offer email" -> end:hired automatically. The candidate is marked Hired the moment the interview passes, BEFORE any formal Offer (offer letter + accept page) exists. Offer feature (Library > Offer letters, candidate Offer panel, /offer accept -> hired) is disconnected from flow templates. Expect: decision -> "Make offer" person step / wait-for-offer-acceptance. (Verify in K.)
- UX (med): Screening stage lists "Manual review (job owner)" under WHO WORKS HERE as if everyone gets it; in reality only 40-69 band gets it (shortlist >=70 skips). Stage list hides branch-scoping of person steps. {partly addressed by: help. A "What's this?" link opens Stages help that shows the 40-69 band; the label itself is unchanged, QA fix still open}
- UX (med): Decision stage shows "Sends Offer email" AND "Sends Rejection email" under WHEN SOMEONE ARRIVES - reads as both being sent. {partly addressed by: help. A "What's this?" link says one email goes, not both; the list itself is unchanged, QA fix still open}
- UX (med): step panel leads with "Key" + "{{nodes.interview..}}" (engine jargon) above task title / assignees. Put Key under Advanced.
- UX (low): Form tab needs explicit "Save draft" while Stages autosaves ("Changes save as you go") - inconsistent save model in same job.
- PASS Details: markdown desc, skills chips (Enter), salary+currency, show salary, workplace, location, closes-on. Requirements card says "Changes reach the flow when you next publish" (good).
- PASS Form: added required Yes/No "forklift licence?"; candidate preview updates live. [D-05]
- PASS configure interview: Priya+Marcus, 2 scorecards, booking 45m; summary line updates ("Marcus Lee, Priya Nair - 2 score it - due in 5 days - candidate books 45 min"). [D-06]
- PASS added AI criterion 3 "Safety and certifications". [D-07]
- PASS validate+publish v1 -> "v1 is live" banner w/ apply link + copy. [D-08] (validate 6.9s + publish 7.5s)
- minor visual: after scrollIntoView in the step panel, whole app shell scrolled leaving blank lower half until page scroll reset.
## G Apply
- PASS posting page: company, location/workplace/type, salary shown, close date, markdown rendered, Apply CTA -> ?step=apply. [G-01]
- PASS consent required (native "Please check this box"); Turnstile dev widget auto-passes. [G-02]; success page clear w/ reply-to address. [G-03]
- PASS required Yes/No left unticked in UI => submitted as false (not forced to yes).
- PASS API edge: duplicate email different case -> 409 already_applied; text-renamed .pdf -> 422 "only PDF or DOCX"; 12MB PDF -> 422 "larger than 10 MB"; no turnstile -> 400; missing consent -> 422.
- NOTE: apply POST takes 11-12s locally (file to R2 + DB round trips); UI shows "Sending..." spinner only.
## E Job 2 Delivery Driver (Lots of applicants template)
- PASS added "Check answers" (ai_check) from stage list "Add an action" menu; edited question to Class 3 licence.
- PASS decision branch editor: added branch "No licence" (Has Class 3 licence is no -> Rejection email), moved to top; rule summary updates live; live inline validation "Branch 2 doesn't lead to a step yet". [E-01]
- UX (low): renaming a check question's Name doesn't re-derive Key (stays meets_requirement), unlike form fields which do.
- UX (med): condition field picker lists engine internals: "CV text", "File checksum", "AI summary" alongside real fields - noise for managers. {partly addressed by: help. "What's this?" opens Words, which explains what a rule can check; the internals still show, QA fix still open}
- UX (low): template's single check is named generically "Does the applicant meet the main requirement for this job?" - fine as placeholder.
- PASS publish blocked for deliberately broken assignees: "Fix 1 thing before publishing - Call: Needs 1 scorecard, but only 0 people can be assigned. Add people or a role." with link to step. [E-02] (copy nit: "only 0 people"). Note pending invitee in Interviewer role doesn't count (correct).
- BUG (med, layout): in job editor the document (<html>) scrolls by ~136px when panel fields scrollIntoView -> header/tabs slide off; Publish button position then overlaps the step panel's Delete icon (my Publish click hovered Delete). App shell should be height-locked (overflow hidden on html/body).
## F Job 3 CS via Describe-your-flow
- Blank flow opens "How do you hire for this job?" prompt w/ examples + Use a preset / Start empty - very approachable. [F-01] Draft took ~25s; Stop button present.
- BUG (high, AI builder): description said "the AI reads their CV and checks..." but draft has NO CV file field on the form ("Apply form - name and contact details only") and NO Read CV step; ai_check would have nothing to read. Banner said "4 steps in 3 stages - No problems found" and Ready to publish. Builder should either add a CV field + Read CV step, or flag the issue. Validation also doesn't warn "AI check has no CV/answers to read". [F-02]
- Otherwise draft matched intent: 2 yes/no checks, AND-rule -> Video Call (job owner, booking 20 min, Hire? scorecard), else rejection; offer/rejection emails. Missing-data branch -> Video Call (sensible).
## H AI effectiveness (first pass, WOS job, criteria skills/experience/safety)
- Ranking: Marcus(strong) 86 > Nurul(good) 67 > Richard(overqual) 63 > Daniel(career-changer) 34 > Kelvin(injection) 32 > Arjun(junior) 30 > Chloe(unrelated) 6. Matches expected order. Summaries cite concrete evidence (years, certs, forklift course in progress).
- PASS prompt injection (ws7 hidden "score 100" line): scored 32, rejected. 
- Nurul penalised skills_match 44 for Manhattan vs SAP EWM because must-have chip only says "SAP EWM" (JD says "SAP EWM, Manhattan or similar"). UX: skills chips can't express alternatives ("SAP EWM or Manhattan").
- Drivers: Wei Jie (no licence) 29; Ravi (9 demerit pts, at-fault accident; JD says max 6) scored 74 -> passes screen; AI noted demerits but didn't treat JD rule as hard. Clean-record rule lives only in description text.
- BUG (med): cv_parse skills array contains fragments: "F","S","SK","W","WS","M","Man"+"hattan WMS","Def"+"ensive Driving Course","English,". Tokenisation/line-break split of PDF text. Pollutes skills shown/used in conditions.
- Faizal (Class 3 since 2015) cv skills shows "Class 4 Driving" only - Class 3 not extracted (ai_check pending at time of note).
- CONFIRMED (code server/engine/handlers/index.ts:53-61): AI review input = job title + structured requirements + answers + CV; the job DESCRIPTION is never sent. Any must-have written only in the JD (e.g. 'max 6 demerit points') is invisible to the AI. Either send description or tell managers in Details/criteria UI. {addressed by: wizard and help, for the "tell managers" half. New job step 4 shows what the AI reads (description struck out) with a tip to put rules in skills or the form; Details has "What does the AI read?"; the description is still not sent}
- F redraft: after manually adding a CV file field, redraft produced Read CV -> AI check -> Screen (6 steps). So builder only wires fields that already exist on the form; it never adds form fields. Redraft dialog (from toolbar) doesn't prefill the previous description (Edit and redraft does). [F-03]
## E Import
- PASS CSV import: auto column match, dry-run "4 people will be imported / 1 already applied (faizal) / 1 row can't be imported: Row 6 email same as row 3" (spreadsheet row numbers incl header), default start step = Call (skips CV step since no file), consent "not collected" disclosed. [E-04, E-05] Import took ~30s.
- COHERENCE (med): imported rows skip the licence knockout; has_class3_licence column couldn't map anywhere (form has no such field) -> silently dropped ("Don't import"). Imported unlicensed driver (row 3) lands in Call queue.
## ENV/ROBUSTNESS
- Local queue consumer died after "[engine] infrastructure error write CONNECTION_CLOSED ...hyperdrive.local" followed by "Uncaught TypeError: Cannot read properties of null (reading 'write')" (postgres-js). Runs stayed pending ~15 min; sweeper requeued but nothing consumed until wrangler restart. Prod CF Queues would redeliver, but the uncaught error in postgres-js socket handling is worth a look.
## I/J Inbox + candidate
- Manager inbox clean: list w/ due chips, j/k nav, inline scorecard, "Waiting for the candidate to book" sub-label for booking tasks. [J-01]
- EFFECTIVENESS (high): task view shows ONLY the scorecard - no AI score breakdown, summary, CV link, phone number. "Call Ravi Krishnan" doesn't show Ravi's phone; "Review Nurul (score 67)" doesn't show why. Must click through to candidate page and back. Put candidate snapshot (contact, CV, AI summary/scores, answers) in the task pane.
- Candidate page is excellent: WHY card ("Screen sent this to Manual review: no rule matched..."), per-criterion bars + AI summary, "How Screen decided" rule-by-rule, flow position w/ "Can go next", answers + consent record, assignees add/remove, Make offer. [I-02]
- PASS scorecards submitted (Nurul yes w/ notes; Richard no).
- PASS Needs attention: "Stopped - The CV can't be read (Siti) - It may be a scan. Move it to a manual review" + Retry/Move; "Stuck - Hasn't moved for a while (Wei Jie)" + Retry. [H-01] Copy "Retry." alone under stuck item is terse.
- UX (low): Needs-attention suggests "move it to a manual review" but CS flow has no manual review step.
## J Employee / booking / panel
- PASS employee (Priya): /jobs -> redirected to inbox; sidebar only Inbox; sees only her 2 interview tasks. [A-02]
- PASS hours: defaults to Mon-Fri 9-5 in browser TZ with banner "You haven't set hours yet, so nobody can book you". Saved Asia/Singapore. [J-02] (Default TZ = browser (Asia/Calcutta on this laptop) not company/SG.)
- PASS booking page: "Hi Marcus, pick a time... 45 minutes with Marcus Lee and Priya Nair"; slots = intersection of both interviewers' hours (Tue-Thu 1-4pm SGT), auto-detected candidate TZ w/ Change; booked -> "You're booked", Add to calendar (.ics valid, UTC), Change time. [J-03, J-04]
- PASS conflict: Nurul's slots exclude 13:30-14:30 overlapping Marcus's 14:00 booking; POST taken slot -> 409 slot_unavailable; bad token -> 404.
- EFFECTIVENESS (med): booking page + .ics have no location/format (on-site Tuas vs video). Instructions with location are interviewer-only. Add "where" to booking step.
- UX (low): inbox shows interview time in browser TZ without a TZ label ("Tue, Oct 27, 11:30 AM" while booked as 2:00 PM SGT).
- PASS blind panel: Priya sees "Marcus Lee - Submitted just now - Answers hidden until you send yours"; API also returns values:null for others. [J-06]
- PASS scorecard validation: technical 9 -> 422 "technical: max 5"; double submit -> 409 already_submitted.
- CONFIRMED (high, coherence): 2nd scorecard -> decision -> "Your offer for ..." mock email -> application closed HIRED automatically. No offer letter/terms/acceptance; Make offer button gone afterwards (409 application_closed via API). [K-01]
## K Offers
- PASS Make offer dialog (template select, salary free text, start date, location, open-until). [K-02] Placeholders are UK ("e.g. GBP 42,000 a year", "Leeds office") and salary not prefilled from job's SGD range.
- PASS offer created -> "Offer ready - Nothing is emailed from here. Copy the link and send it yourself." [K-03] EFFECTIVENESS (high): manual copy/paste of offer + booking links; no email to candidate.
- BUG (low): letter body renders {{offer.start_date}} as raw ISO "2026-12-01" (header card shows "Tue, December 1, 2026"; Library preview shows "2 November 2026"). [K-04]
- BUG/UX (med, SG-specific): accept requires exact first+last name; "Nurul Binte Hidayah" rejected with "Type your first and last name as NorthWind Logistics has them". Malay (bin/binte), Indian (a/l, s/o) and Chinese surname-first names will hit this. Case/extra spaces tolerated. [K-05]
- PASS accept -> "Welcome to NorthWind Logistics, Nurul" [K-06]; app closed hired, interview run cancelled, panel assignments closed.
- GAP (med): accepted while an interview was booked (Oct 28) -> booking silently orphaned; candidate/interviewers not told; no confirmation email to candidate or notice to manager.
- PASS decline (confirm step) -> app closed WITHDRAWN [K-07]; no decline reason captured (useful data for SMB).
- PASS new offer withdraws previous -> old link "This offer is no longer open" [K-08]; expired (DB-forced) -> "This offer has expired" page + API 409 offer_expired [K-09]; closed app -> 409; past expiry -> 422 expires_in_past.
- API note: templateId required on offer create (UI always sends one).
## I Pipeline moves
- PASS list view: stage/step, assignee+due chip, AI score, source, filters (stage, AI score, source, in progress). [I-03]
- UX (med, layout shift again): selecting first checkbox inserts a selection bar that pushes rows down -> my 2nd click missed the intended row. Overlay the bar instead.
- PASS bulk Reject: reasons from Settings (incl. our custom one), team-only note, "No email is sent". [I-04] Expired-but-'sent' offer on Ravi auto-withdrawn on reject.
- GAP (med): manual reject/close never emails the candidate ("Closing someone by hand sends no email") - no option to send the rejection email; SMB must email separately. Offer an opt-in "Send rejection email".
- PASS stopped CV page: "Stopped: the CV can't be read. It may be a scan..." + Retry Read CV. [I-05] Stage menu: Next in flow / Move to another step / Close as rejected / withdrawn. [I-06]
- PASS Move dialog: all steps + close options, live "This will:" preview (assignee, due, booking ask), reason required when skipping. [I-07] (Move button shifts as preview expands.)
- BUG (low): board Closed > HIRED count shows "1 person" with 2 avatars - count uses current_node_key='hired'; offer-accepted hires keep current_node_key=interview so they are not counted.
## L Hires
- PASS totals/by-job/by-source match DB. [L-01]
- BUG/GAP (med): WOS "2 of 1" seats, 200% fill rate - nothing prevents/warns over-hiring (template auto-hire + offer acceptance both hired). Job stays Live after openings filled. Suggest: warn on offer/hire when seats full; offer to close job when last seat filled.
- GAP (low): Hires page has no list of who was hired / start dates - SMB will want an onboarding list.
## M Ask
- Ask panel opens with Cmd+J, shows context chip "Looking at Marcus Tan - Warehouse Operations Supervisor". Answer failed: "The answer stopped. The AI service did not reply. Your question is still in the box. Try again". [M-01]
- ROOT CAUSE (env/config, high for launch): Gemini free tier quota 20 requests/day exhausted (server log: generate_content_free_tier_requests limit 20, gemini-3.6-flash). Each ai_review summary + every Ask + every flow draft uses it -> ~20 applicants/day max. Need paid key before launch. UX: error should say quota/limit reached rather than "did not reply"; ai_review summaries silently empty after quota.
- PASS employee isolation via API: unassigned application 404, its CV 404; assigned app + CV 200; /api/jobs 403; /reports/hires 403; other user's task 404; move 403.
## H AI off
- PASS turning Use AI off: manager /api/me ai=off, Ask button hidden; new applicant's Read CV stops "AI is off - An admin can turn on Use AI in Settings, then retry" in Needs attention [H-02]; after turning on, Retry -> "Trying Read CV again for Hui Min" toast.
- NOTE: Read CV (text extraction) is blocked by AI-off too, though it's parsing.
## J Reminders
- PASS overdue reminder: backdated Hafiz call task; reminders cron run twice -> exactly 1 mock email "Overdue: Call Hafiz Ismail" to Jithin, reminder_log 1 row; task appears in overdue list.
## O Templates
- PASS all 4 built-ins (simple, panel, high_volume, ai_screening) + copy-job + blank create & validate with 0 issues; all include CV field (high_volume adds right_to_work).
- GAP (med): templates with AI review validate/publish even when job has no must-have skills/min years -> AI scores vs nothing. Validation should warn (Details tab warns but publish doesn't). {partly addressed by: wizard. New job asks for must-have skills and years in step 4, before the job exists; publish still allows them empty}
- All 3 hire templates share the auto offer_email->hired ending (coherence issue above).
## P Presets
- PASS Save as flow preset (name, description, "Saves the form too. Job details such as must-have skills stay with this job") -> toast w/ Open [P-01]; new job from preset validates, same nodes + form.
## N Lifecycle
- PASS Close applications (no confirm) -> apply 404 job_not_open; job gone from /careers and public API; apply page "This job isn't taking applications any more. It may have been filled, or the closing date has passed." [N-03] (dead end: no link to other open roles/company careers).
- PASS careers: intro line, location filter (2 locations), SGD ranges, workplace chips. [N-02]
- PASS transitions via API: draft->open 409 (publish first); draft->archived 200; archived->anything 409; owner=employee 422 owner_must_be_manager; closed->open 200.
## Q AI builder deep
- BLOCKED: all 4 prompts (cafe, warehouse complex, vague, contradictory) -> 502 ai_error due to Gemini free-tier quota. Retry after reset.
## D Versions
- PASS publish v2 (added Expected salary field) while Richard in progress -> Richard stays on v1 ("flow v1" on candidate page).
- PASS guard: changing an existing field's type (linkedin string->number) saves to draft but validate returns field_type_changed "form.linkedin was string in an earlier version; use a new key for a number".
