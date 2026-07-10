CREATE TABLE IF NOT EXISTS "ota_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"mac" text NOT NULL,
	"model" text,
	"from_version" text,
	"to_version" text,
	"phase" text NOT NULL,
	"error_code" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "firmware_rollouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'full' NOT NULL,
	"percent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ota_events" ADD CONSTRAINT "ota_events_mac_devices_mac_fk" FOREIGN KEY ("mac") REFERENCES "devices"("mac") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ota_events_mac_to_version_idx" ON "ota_events" USING btree ("mac","to_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ota_events_timestamp_idx" ON "ota_events" USING btree ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "firmware_rollouts_version_channel_idx" ON "firmware_rollouts" USING btree ("version","channel");
