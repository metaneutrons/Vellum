-- PostgreSQL does not automatically index the referencing side of a foreign
-- key. These indexes keep cascades, SET NULL, RESTRICT checks, and relationship
-- lookups bounded as fleets and audit/security directories grow.
DROP INDEX IF EXISTS "telemetry_mac_timestamp_idx";
--> statement-breakpoint
CREATE INDEX "telemetry_mac_timestamp_idx" ON "telemetry" ("mac", "timestamp" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_content_instance_idx" ON "devices" ("content_instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_theme_idx" ON "devices" ("theme_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_refresh_profile_idx" ON "devices" ("refresh_profile_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_mac_timestamp_idx" ON "reports" ("mac", "timestamp" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_provider_dependencies_provider_idx" ON "content_provider_dependencies" ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_asset_dependencies_asset_idx" ON "content_asset_dependencies" ("asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_role_assignments_role_idx" ON "user_role_assignments" ("role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_invitations_role_idx" ON "admin_invitations" ("role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_invitations_created_by_idx" ON "admin_invitations" ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_accounts_created_by_idx" ON "service_accounts" ("created_by");
