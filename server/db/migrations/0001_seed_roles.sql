-- Default roles; rename freely, only `level` carries permissions.
INSERT INTO "roles" ("name", "level") VALUES ('Manager', 'manager'), ('Employee', 'employee') ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
