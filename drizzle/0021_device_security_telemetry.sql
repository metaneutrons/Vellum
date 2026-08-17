ALTER TABLE "telemetry" ADD COLUMN IF NOT EXISTS "security_profile" text;
ALTER TABLE "telemetry" ADD COLUMN IF NOT EXISTS "nvs_integrity" text;
