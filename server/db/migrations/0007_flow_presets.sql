CREATE TABLE "flow_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"form" jsonb NOT NULL,
	"workflow" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
