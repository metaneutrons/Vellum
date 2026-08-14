-- A device owns its operational telemetry, issue reports, and OTA history.
-- Delete those rows atomically with the device while keeping the independent,
-- append-only audit log intact. The single DO statement is transactional even
-- with Vellum's statement-by-statement migration runner.
DO $$
DECLARE
  device_fk record;
BEGIN
  -- The original hand-written schema lets PostgreSQL choose constraint names
  -- (for example telemetry_mac_fkey), while databases first created through
  -- drizzle-kit use generated names (telemetry_mac_devices_mac_fk). Remove the
  -- actual device references by identity so both installation histories upgrade.
  FOR device_fk IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'devices'::regclass
      AND conrelid IN (
        'telemetry'::regclass,
        'reports'::regclass,
        'ota_events'::regclass
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      device_fk.table_name,
      device_fk.conname
    );
  END LOOP;

  ALTER TABLE "telemetry"
    ADD CONSTRAINT "telemetry_mac_devices_mac_fk"
    FOREIGN KEY ("mac") REFERENCES "devices"("mac") ON DELETE CASCADE ON UPDATE NO ACTION;

  ALTER TABLE "reports"
    ADD CONSTRAINT "reports_mac_devices_mac_fk"
    FOREIGN KEY ("mac") REFERENCES "devices"("mac") ON DELETE CASCADE ON UPDATE NO ACTION;

  ALTER TABLE "ota_events"
    ADD CONSTRAINT "ota_events_mac_devices_mac_fk"
    FOREIGN KEY ("mac") REFERENCES "devices"("mac") ON DELETE CASCADE ON UPDATE NO ACTION;

  -- The Console promises that deleting assigned content, themes, or refresh
  -- profiles leaves the device unassigned so it can use its documented
  -- fallback. The old NO ACTION constraints instead rejected the deletion.
  FOR device_fk IN
    SELECT conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'devices'::regclass
      AND confrelid IN (
        'content_instances'::regclass,
        'themes'::regclass,
        'refresh_profiles'::regclass
      )
  LOOP
    EXECUTE format('ALTER TABLE "devices" DROP CONSTRAINT %I', device_fk.conname);
  END LOOP;

  ALTER TABLE "devices"
    ADD CONSTRAINT "devices_content_instance_id_content_instances_id_fk"
    FOREIGN KEY ("content_instance_id") REFERENCES "content_instances"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

  ALTER TABLE "devices"
    ADD CONSTRAINT "devices_theme_id_themes_id_fk"
    FOREIGN KEY ("theme_id") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

  ALTER TABLE "devices"
    ADD CONSTRAINT "devices_refresh_profile_id_refresh_profiles_id_fk"
    FOREIGN KEY ("refresh_profile_id") REFERENCES "refresh_profiles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

  -- Older builds did not enforce the single-default theme invariant. Keep the
  -- most recently edited default if such a database already contains several,
  -- then make the invariant impossible to violate under concurrent requests.
  UPDATE "themes"
  SET "is_default" = false, "updated_at" = now()
  WHERE "is_default"
    AND "id" NOT IN (
      SELECT "id" FROM "themes"
      WHERE "is_default"
      ORDER BY "updated_at" DESC, "id"
      LIMIT 1
    );

  CREATE UNIQUE INDEX IF NOT EXISTS "themes_one_default_idx"
    ON "themes" ("is_default") WHERE "is_default";
END
$$;
