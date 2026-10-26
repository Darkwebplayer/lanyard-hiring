ALTER TABLE "candidate_emails" ADD COLUMN "node_key" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "status_token" text;--> statement-breakpoint
-- existing candidates: 32 random hex characters (new ones get 32 base64url characters from the app)
UPDATE "candidates" SET "status_token" = replace(gen_random_uuid()::text, '-', '');--> statement-breakpoint
ALTER TABLE "candidates" ALTER COLUMN "status_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_status_token_unique" UNIQUE("status_token");
