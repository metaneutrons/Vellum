ALTER TABLE "telemetry" ADD COLUMN IF NOT EXISTS "wifi_ssid" text;
ALTER TABLE "telemetry" ADD COLUMN IF NOT EXISTS "wifi_security" text;
