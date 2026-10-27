CREATE TABLE "booking_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "availability" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "availability" CASCADE;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "offered_by" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "noted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "team_note" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_offers" ADD CONSTRAINT "booking_offers_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_offers_time" ON "booking_offers" USING btree ("booking_id","starts_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_offered_by_user_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;