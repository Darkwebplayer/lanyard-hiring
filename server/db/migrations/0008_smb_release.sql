CREATE TYPE "public"."offer_status" AS ENUM('sent', 'accepted', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TABLE "availability" (
	"user_id" text PRIMARY KEY NOT NULL,
	"timezone" text NOT NULL,
	"hours" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"token" text NOT NULL,
	"duration_min" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "bookings_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "offer_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"token" text NOT NULL,
	"terms" jsonb NOT NULL,
	"letter" text NOT NULL,
	"status" "offer_status" DEFAULT 'sent' NOT NULL,
	"expires_at" timestamp with time zone,
	"signed_name" text,
	"responded_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "consent" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "careers_intro" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "reject_reasons" jsonb DEFAULT '["Not enough experience","Skills don’t match","Salary expectations","Position filled","Other"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_run_id_node_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."node_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offers_application_idx" ON "offers" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_one_sent_uq" ON "offers" USING btree ("application_id") WHERE "offers"."status" = 'sent';