-- Content renderer configuration is intentionally flexible JSONB, but provider
-- and asset identifiers inside it are real relational dependencies. Materialize
-- those references so PostgreSQL can reject dangling writes and unsafe deletes.
CREATE TABLE IF NOT EXISTS "content_provider_dependencies" (
  "content_instance_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  CONSTRAINT "content_provider_dependencies_pkey" PRIMARY KEY ("content_instance_id", "provider_id"),
  CONSTRAINT "content_provider_dependencies_content_instance_id_fk"
    FOREIGN KEY ("content_instance_id") REFERENCES "content_instances"("id") ON DELETE CASCADE,
  CONSTRAINT "content_provider_dependencies_provider_id_fk"
    FOREIGN KEY ("provider_id") REFERENCES "data_providers"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_asset_dependencies" (
  "content_instance_id" uuid NOT NULL,
  "asset_id" uuid NOT NULL,
  CONSTRAINT "content_asset_dependencies_pkey" PRIMARY KEY ("content_instance_id", "asset_id"),
  CONSTRAINT "content_asset_dependencies_content_instance_id_fk"
    FOREIGN KEY ("content_instance_id") REFERENCES "content_instances"("id") ON DELETE CASCADE,
  CONSTRAINT "content_asset_dependencies_asset_id_fk"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "refresh_content_dependencies"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "content_provider_dependencies" WHERE "content_instance_id" = NEW."id";
  DELETE FROM "content_asset_dependencies" WHERE "content_instance_id" = NEW."id";

  INSERT INTO "content_provider_dependencies" ("content_instance_id", "provider_id")
  SELECT NEW."id", refs."provider_id"::uuid
  FROM (
    SELECT NEW."config"->>'providerId' AS "provider_id"
    UNION
    SELECT resource->>'providerId'
    FROM jsonb_array_elements(COALESCE(NEW."config"->'resources', '[]'::jsonb)) AS resource
  ) AS refs
  WHERE refs."provider_id" IS NOT NULL AND refs."provider_id" <> ''
  ON CONFLICT DO NOTHING;

  INSERT INTO "content_asset_dependencies" ("content_instance_id", "asset_id")
  SELECT DISTINCT NEW."id", (asset_ref #>> '{}')::uuid
  FROM jsonb_path_query(NEW."config", 'lax $.**.backgroundAssetId') AS asset_ref
  WHERE asset_ref <> 'null'::jsonb AND (asset_ref #>> '{}') <> ''
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_dependencies_refresh" ON "content_instances";
--> statement-breakpoint
CREATE TRIGGER "content_dependencies_refresh"
AFTER INSERT OR UPDATE OF "config" ON "content_instances"
FOR EACH ROW EXECUTE FUNCTION "refresh_content_dependencies"();
--> statement-breakpoint
-- Backfill and validate every existing configuration through the same trigger.
-- Any historical dangling reference stops the migration rather than silently
-- certifying an inconsistent database.
UPDATE "content_instances" SET "config" = "config";
--> statement-breakpoint
-- Audit records are application-append-only. Protect that contract at the
-- database boundary as well, so an accidental ORM update/delete cannot rewrite
-- security history. A database owner can still perform an explicit controlled
-- maintenance procedure by disabling the trigger.
CREATE OR REPLACE FUNCTION "reject_audit_log_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_logs_append_only" ON "audit_logs";
--> statement-breakpoint
CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "reject_audit_log_mutation"();
