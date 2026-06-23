CREATE INDEX IF NOT EXISTS "telemetry_mac_timestamp_idx" ON "telemetry" USING btree ("mac","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_timestamp_idx" ON "telemetry" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "themes_is_default_idx" ON "themes" USING btree ("is_default");
