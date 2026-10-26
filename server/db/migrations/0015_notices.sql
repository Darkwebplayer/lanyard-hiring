CREATE TABLE "notice_marks" (
	"user_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "notice_marks_user_id_seq_pk" PRIMARY KEY("user_id","seq")
);
--> statement-breakpoint
CREATE TABLE "notice_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"seen_seq" bigint DEFAULT 0 NOT NULL,
	"cleared_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notice_marks" ADD CONSTRAINT "notice_marks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_state" ADD CONSTRAINT "notice_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_seq_idx" ON "application_events" USING btree ("seq");