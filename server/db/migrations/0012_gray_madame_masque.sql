ALTER TABLE "candidate_emails" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_emails" ADD COLUMN "failed_at" timestamp with time zone;