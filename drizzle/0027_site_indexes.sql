-- Leading indexes for the new foreign keys.
--
-- schema.test.ts enforces one per foreign key, and it caught this omission: the
-- sites migration created four references and no indexes. Without them, deleting
-- a site scans the devices table, and "which displays are in this site" is the
-- query the sites page runs on every load.
--
-- Unmodified drizzle-kit output.
CREATE INDEX "devices_site_idx" ON "devices" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "sites_refresh_profile_idx" ON "sites" USING btree ("refresh_profile_id");--> statement-breakpoint
CREATE INDEX "sites_theme_idx" ON "sites" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX "sites_content_instance_idx" ON "sites" USING btree ("content_instance_id");