-- Let an operator designate which refresh profile applies to displays that have
-- none assigned. The device picker has always offered a "Default" option, but it
-- resolved to hard-coded constants in src/lib/sleep — invisible and unchangeable.
--
-- Nothing is seeded on purpose: with no row flagged, resolution still falls back
-- to those built-in constants and the admin UI says so plainly. The choice is the
-- operator's, not ours.
--
-- Mirrors themes.is_default, which has worked this way since 0000.
ALTER TABLE "refresh_profiles" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS "refresh_profiles_is_default_idx" ON "refresh_profiles" USING btree ("is_default");

-- At most one default, enforced by the database rather than by application code:
-- a partial unique index over the true values makes two defaults unrepresentable.
-- Consequence for callers: setting a new default must clear the old one in the
-- SAME transaction, or the second UPDATE violates this index.
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_profiles_one_default_idx"
  ON "refresh_profiles" ("is_default") WHERE "is_default";
