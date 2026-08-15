ALTER TABLE "telemetry" ADD COLUMN IF NOT EXISTS "power_source" text;
--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN IF NOT EXISTS "battery_status" text;
