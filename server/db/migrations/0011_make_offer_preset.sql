-- the Make offer step (shared/workflow/registry.ts MAKE_OFFER) in every company's palette, after its person steps
INSERT INTO "step_presets" ("type", "label", "description", "config", "position")
SELECT 'human_task', 'Make offer', 'You make the offer; their answer, on the link or recorded, moves them on.',
  '{"title":"Make an offer to {{candidate.first_name}} {{candidate.last_name}}","instructions":"Use Make offer… to email the letter. This closes when they answer on the link, or when you record their answer.","scorecard":[],"min_submissions":1,"due_days":3,"offer":true,"assignees":{"users":[],"roles":[],"job_owner":true}}'::jsonb,
  coalesce(max("position"), 0) + 1
FROM "step_presets" WHERE "type" = 'human_task';
