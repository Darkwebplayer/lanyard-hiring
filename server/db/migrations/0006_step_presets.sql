CREATE TABLE "step_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"in_palette" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- seed: the built-in presets from shared/workflow/presets.ts
INSERT INTO "step_presets" ("type", "label", "description", "config", "position") VALUES
('ai_review', 'AI review: skills and experience', 'Scores the CV against the must-have skills and the minimum years.', '{"criteria":[{"key":"skills_match","label":"Skills match","description":"How well the CV matches the must-have skills"},{"key":"experience","label":"Experience","description":"Relevant experience against the minimum years"}],"cv_text_ref":"nodes.cv.text"}'::jsonb, 0),
('send_email', 'Offer email', 'Tells the candidate they have an offer.', '{"subject":"Your offer for {{job.title}}","body":"Hi {{candidate.first_name}},\n\nWe are delighted to offer you the {{job.title}} role. We will be in touch with the details shortly."}'::jsonb, 1),
('send_email', 'Rejection email', 'Thanks the candidate and says how to ask for another look.', '{"subject":"Your application for {{job.title}}","body":"Hi {{candidate.first_name}},\n\nThank you for applying for {{job.title}}. We have decided not to move forward this time. Reply to this email if you would like us to look again."}'::jsonb, 2),
('condition', 'Screen by AI score', 'Shortlist at 70 or more, reject under 40, a person reviews the rest.', '{"branches":[{"key":"shortlist","label":"Shortlist","rule":{"ref":"nodes.ai.overall","op":"gte","value":70}},{"key":"reject","label":"Reject","rule":{"ref":"nodes.ai.overall","op":"lt","value":40}}],"on_missing":true}'::jsonb, 0),
('human_task', 'Interview', '4 questions, due in 5 days.', '{"title":"Interview {{candidate.first_name}} {{candidate.last_name}}","scorecard":[{"key":"technical","label":"Technical skills (1–5)","type":"number","required":true,"min":1,"max":5},{"key":"communication","label":"Communication (1–5)","type":"number","required":true,"min":1,"max":5},{"key":"hire","label":"Hire?","type":"boolean","required":true},{"key":"notes","label":"Notes","type":"text","required":false}],"min_submissions":1,"due_days":5,"assignees":{"users":[],"roles":[],"job_owner":true}}'::jsonb, 0),
('human_task', 'Technical assessment review', '3 questions, due in 3 days.', '{"title":"Review assessment: {{candidate.first_name}} {{candidate.last_name}}","scorecard":[{"key":"score","label":"Score (0–100)","type":"number","required":true,"min":0,"max":100},{"key":"pass","label":"Pass?","type":"boolean","required":true},{"key":"notes","label":"Notes","type":"text","required":false}],"min_submissions":1,"due_days":3,"assignees":{"users":[],"roles":[],"job_owner":true}}'::jsonb, 1),
('human_task', 'HR approval', '2 questions, due in 2 days.', '{"title":"Approve offer for {{candidate.first_name}} {{candidate.last_name}}","scorecard":[{"key":"approved","label":"Approved?","type":"boolean","required":true},{"key":"notes","label":"Notes","type":"text","required":false}],"min_submissions":1,"due_days":2,"assignees":{"users":[],"roles":[],"job_owner":true}}'::jsonb, 2),
('end', 'Hired', 'Closes the application as hired.', '{"outcome":"hired"}'::jsonb, 0),
('end', 'Rejected', 'Closes the application as rejected.', '{"outcome":"rejected"}'::jsonb, 1),
('end', 'Withdrawn', 'Closes the application as withdrawn.', '{"outcome":"withdrawn"}'::jsonb, 2);
