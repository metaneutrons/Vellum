-- Normalize constraint names and backfill CHECK constraints so every database
-- matches what src/db/schema.ts declares.
--
-- Why this is needed at all. 0006, 0007 and 0018 declare their foreign keys
-- inline inside CREATE TABLE without naming them, so PostgreSQL derives
-- <table>_<column>_fkey. The model pins exactly those names, because drizzle's
-- inline .references() cannot pin one and would otherwise imply its own longer
-- <table>_<column>_<reftable>_<refcol>_fk, which no migrated database has.
--
-- On any database built by running drizzle/*.sql in order, the names already
-- match and this migration does nothing. The exception is a database that
-- scripts/migrate.mjs self-baselined: a CREATE TABLE that failed as
-- duplicate_table is skipped whole and recorded as applied, so a table created
-- earlier by `drizzle-kit push` keeps push's names and never receives the
-- table's CHECK constraints. For those, the model would name constraints that
-- do not exist, and a future generated migration altering one would fail on a
-- missing constraint. This closes that gap.
--
-- Constraints are identified through pg_constraint by what they DO — table,
-- column, referenced table — never by name, the same approach 0012 uses to
-- rewrite foreign keys whose names it cannot predict. Renaming preserves the
-- constraint, so no data is revalidated and no index is rebuilt.
DO $$
DECLARE
  target record;
  existing text;
  rel oid;
BEGIN
  -- Single-column foreign keys. Matched on (table, column, referenced table),
  -- which is unique for every entry below.
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('role_permissions', 'role_id', 'access_roles', 'role_permissions_role_id_fkey'),
        ('user_role_assignments', 'user_id', 'admin_users', 'user_role_assignments_user_id_fkey'),
        ('user_role_assignments', 'role_id', 'access_roles', 'user_role_assignments_role_id_fkey'),
        ('admin_sessions', 'user_id', 'admin_users', 'admin_sessions_user_id_fkey'),
        ('admin_invitations', 'role_id', 'access_roles', 'admin_invitations_role_id_fkey'),
        ('admin_invitations', 'created_by', 'admin_users', 'admin_invitations_created_by_fkey'),
        ('oidc_identities', 'user_id', 'admin_users', 'oidc_identities_user_id_fkey'),
        ('service_accounts', 'created_by', 'admin_users', 'service_accounts_created_by_fkey'),
        ('service_account_permissions', 'service_account_id', 'service_accounts', 'service_account_permissions_service_account_id_fkey'),
        ('content_provider_dependencies', 'content_instance_id', 'content_instances', 'content_provider_dependencies_content_instance_id_fk'),
        ('content_provider_dependencies', 'provider_id', 'data_providers', 'content_provider_dependencies_provider_id_fk'),
        ('content_asset_dependencies', 'content_instance_id', 'content_instances', 'content_asset_dependencies_content_instance_id_fk'),
        ('content_asset_dependencies', 'asset_id', 'assets', 'content_asset_dependencies_asset_id_fk'),
        ('device_configuration_commands', 'mac', 'devices', 'device_configuration_commands_mac_fkey'),
        ('device_configuration_commands', 'created_by', 'admin_users', 'device_configuration_commands_created_by_fkey')
    ) AS t(tbl, col, reftbl, expected)
  LOOP
    -- to_regclass rather than a cast: a cast raises on a missing table, and this
    -- must stay a no-op on a database that legitimately lacks one.
    rel := to_regclass('public.' || quote_ident(target.tbl));
    CONTINUE WHEN rel IS NULL;

    -- Scoped to the table: conname is unique per table, not per schema.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = rel AND conname = target.expected
    );

    SELECT c.conname INTO existing
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.conrelid = rel
      AND c.contype = 'f'
      AND c.confrelid = to_regclass('public.' || quote_ident(target.reftbl))
      AND cardinality(c.conkey) = 1
      AND a.attname = target.col
    LIMIT 1;

    IF existing IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
                     target.tbl, existing, target.expected);
      RAISE NOTICE 'renamed %.% constraint % to %', target.tbl, target.col, existing, target.expected;
    END IF;
  END LOOP;

  -- Composite primary keys. A table has at most one, so no column matching.
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('content_provider_dependencies', 'content_provider_dependencies_pkey'),
        ('content_asset_dependencies', 'content_asset_dependencies_pkey')
    ) AS t(tbl, expected)
  LOOP
    rel := to_regclass('public.' || quote_ident(target.tbl));
    CONTINUE WHEN rel IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = rel AND conname = target.expected
    );

    SELECT conname INTO existing
    FROM pg_constraint
    WHERE conrelid = rel AND contype = 'p'
    LIMIT 1;

    IF existing IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
                     target.tbl, existing, target.expected);
      RAISE NOTICE 'renamed %s primary key % to %', target.tbl, existing, target.expected;
    END IF;
  END LOOP;

  -- CHECK constraints 0006 creates inline. A self-baselined database never got
  -- them. Added NOT VALID deliberately: it enforces every future insert and
  -- update without scanning existing rows, so a database holding a row that
  -- predates the rule is corrected going forward instead of failing the
  -- migration and refusing to boot. Run VALIDATE CONSTRAINT by hand if a full
  -- check is wanted.
  IF to_regclass('public.admin_users') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.admin_users'::regclass AND conname = 'admin_users_status_check'
     ) THEN
    ALTER TABLE "admin_users"
      ADD CONSTRAINT "admin_users_status_check"
      CHECK ("status" IN ('active', 'invited', 'suspended')) NOT VALID;
    RAISE NOTICE 'added admin_users_status_check';
  END IF;

  IF to_regclass('public.user_role_assignments') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.user_role_assignments'::regclass
         AND conname = 'user_role_assignments_scope_check'
     ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT "user_role_assignments_scope_check"
      CHECK (("scope_type" = 'workspace' AND "scope_id" IS NULL)
             OR ("scope_type" <> 'workspace' AND "scope_id" IS NOT NULL)) NOT VALID;
    RAISE NOTICE 'added user_role_assignments_scope_check';
  END IF;

  IF to_regclass('public.service_accounts') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.service_accounts'::regclass
         AND conname = 'service_accounts_status_check'
     ) THEN
    ALTER TABLE "service_accounts"
      ADD CONSTRAINT "service_accounts_status_check"
      CHECK ("status" IN ('active', 'revoked')) NOT VALID;
    RAISE NOTICE 'added service_accounts_status_check';
  END IF;
END $$;
