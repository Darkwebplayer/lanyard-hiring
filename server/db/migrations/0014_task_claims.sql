ALTER TABLE "task_assignments" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD COLUMN "passed_at" timestamp with time zone;